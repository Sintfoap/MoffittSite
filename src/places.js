// Places for Drift's Locations plugin, from OpenRouteService (built on
// OpenStreetMap): searching for an address or a place by name, and naming the
// spot at a pair of coordinates. The site asks ORS, so the key stays on the
// server; Drift's routing (src/routing.js) uses the same key.
//
//   ORS_API_KEY (a secret): a free key from openrouteservice.org. Without it
//   search is off, and items keep the place you typed but aren't on the map
//   until you give them coordinates (a pin on the map, or pasted).

const API = "https://api.openrouteservice.org";
const TIMEOUT = 8000, RESULTS = 6, MAX_Q = 200;

export const hasPlaces = env => Boolean(env.ORS_API_KEY);

async function ask(env, path, params) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") url.searchParams.set(k, String(v));
  return call(env, url, {});
}

// POSTs `body` to ORS (routing's matrix and directions), or null.
export function post(env, path, body) {
  return call(env, new URL(API + path), { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
}

async function call(env, url, init) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT), headers: { ...init.headers, Authorization: env.ORS_API_KEY, Accept: "application/json" } });
  } catch (e) {
    console.error("openrouteservice didn't answer:", e?.message || e);
    return null;
  }
  if (!res.ok) {
    console.error("openrouteservice said", res.status, "to", url.pathname, (await res.text().catch(() => "")).slice(0, 300));
    return null;
  }
  return res.json().catch(() => null);
}

const toPlace = f => {
  const [lng, lat] = f?.geometry?.coordinates || [];
  return Number.isFinite(lat) && Number.isFinite(lng) ? { place: String(f.properties?.label || "").slice(0, 200), lat, lng } : null;
};

// Places matching `q`, best first: [{place, lat, lng}]. `near` ({lat, lng}),
// when given, favours results close to it. null when ORS can't be asked.
export async function searchPlaces(env, q, near = null) {
  q = String(q ?? "").trim().slice(0, MAX_Q);
  if (!hasPlaces(env) || !q) return hasPlaces(env) ? [] : null;
  const body = await ask(env, "/geocode/search", { text: q, size: RESULTS, "focus.point.lat": near?.lat, "focus.point.lon": near?.lng });
  return body ? (body.features || []).map(toPlace).filter(Boolean) : null;
}

// The name of the spot at lat, lng ("" when there's nothing to call it), or
// null when ORS can't be asked.
export async function nameOf(env, lat, lng) {
  if (!hasPlaces(env)) return null;
  const body = await ask(env, "/geocode/reverse", { "point.lat": lat, "point.lon": lng, size: 1 });
  return body ? toPlace(body.features?.[0])?.place || "" : null;
}
