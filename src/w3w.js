// what3words, for Drift's Locations plugin: turns three words into where they
// are on the map. The site asks what3words, so the key stays on the server.
//
//   W3W_API_KEY (a secret): a what3words API key (developer.what3words.com),
//   on a plan that includes convert-to-coordinates. Without it, items keep
//   their words but aren't placed on the map.

const API = "https://api.what3words.com/v3/convert-to-coordinates";
const TIMEOUT = 8000;

export const hasW3w = env => Boolean(env.W3W_API_KEY);

// {lat, lng, place} for the words; {error} when what3words says they aren't an
// address; null when they can't be placed now (no key, what3words unreachable,
// or it refused the key), so the item keeps its words and is placed on a later save.
export async function toCoordinates(env, words) {
  if (!hasW3w(env)) return null;
  const url = new URL(API);
  url.searchParams.set("words", words);
  url.searchParams.set("key", env.W3W_API_KEY);
  let res, body;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), headers: { Accept: "application/json" } });
    body = await res.json();
  } catch (e) {
    console.error("what3words didn't answer:", e?.message || e);
    return null;
  }
  const c = body?.coordinates;
  if (res.ok && Number.isFinite(c?.lat) && Number.isFinite(c?.lng))
    return { lat: c.lat, lng: c.lng, place: String(body.nearestPlace || "").slice(0, 120) };
  const code = body?.error?.code;
  if (code === "BadWords" || code === "BadWordsFormat") return { error: `what3words doesn’t know ///${words}` };
  console.error("what3words couldn't place an address:", res.status, code || "");
  return null;
}
