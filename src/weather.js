// The forecast for Drift's Weather plugin, from Open-Meteo (no key needed):
// the next 16 days at a spot, a day each. The site asks, so the page and the
// terminal UI get the same answer, and Cloudflare keeps each spot's answer for
// half an hour.
//
// The spot is the one asked for (an item's place, or its collection's base),
// or else where Cloudflare thinks the person asking is (request.cf).

const API = "https://api.open-meteo.com/v1/forecast";
const TIMEOUT = 8000, DAYS = 16;
const DAILY = "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum";

// Two decimals is about a kilometre: close enough for a forecast, and nearby
// items share one answer.
const round = n => Math.round(n * 100) / 100;
const num = v => Number.isFinite(v) ? Math.round(v * 10) / 10 : null;

// {lat, lng, near, days: [{day, code, hi, lo, rain, precip}]}, in °C, mm and
// percent; near says the spot was a guess from the request. null when there's
// nowhere to ask about; {error} when Open-Meteo can't be asked.
export async function forecast(request, lat, lng) {
  let near = false;
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) {
    const cf = request.cf || {};
    lat = Number(cf.latitude); lng = Number(cf.longitude); near = true;
    if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180) || cf.latitude == null) return null;
  }
  lat = round(lat); lng = round(lng);
  const url = new URL(API);
  for (const [k, v] of Object.entries({ latitude: lat, longitude: lng, daily: DAILY, timezone: "auto", forecast_days: DAYS })) url.searchParams.set(k, String(v));
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), cf: { cacheTtl: 1800, cacheEverything: true } }); }
  catch (e) { console.error("open-meteo didn't answer:", e?.message || e); return { error: "the weather service didn’t answer" }; }
  if (!res.ok) {
    console.error("open-meteo said", res.status, (await res.text().catch(() => "")).slice(0, 300));
    return { error: `the weather service answered ${res.status}` };
  }
  const d = (await res.json().catch(() => null))?.daily;
  if (!d || !Array.isArray(d.time)) return { error: "the weather service sent something unreadable" };
  const days = d.time.map((day, i) => ({
    day, code: Number.isInteger(d.weather_code?.[i]) ? d.weather_code[i] : null,
    hi: num(d.temperature_2m_max?.[i]), lo: num(d.temperature_2m_min?.[i]),
    rain: Number.isFinite(d.precipitation_probability_max?.[i]) ? d.precipitation_probability_max[i] : null,
    precip: num(d.precipitation_sum?.[i]),
  }));
  return { lat, lng, near, days };
}
