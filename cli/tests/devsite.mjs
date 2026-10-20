// The site's real Worker (src/) over HTTP on localhost, with an in-memory
// database, for testing the terminal pages against the real APIs.
//
//   node cli/tests/devsite.mjs [--admin] [--notify]
//
// Prints one line of JSON, {origin, token}: a terminal session for "ryan"
// (made through the same code-approval flow `sintfoap login` uses), then
// serves until it's stopped. "sam" has an approved plugin, "stars", in the store.
// ryan can connect Matrix, to a stand-in homeserver (tests/fake-matrix.mjs) at
// matrix.test with the token syt_good, where he's in one room, "Family".
// --notify turns push on (with throwaway keys), gives ryan Notifications and
// one browser to send to, and answers every push as delivered.
// ryan has Recipe box; https://recipes.test/pancakes is a recipe page to save
// (serves 4), and any other page there has no recipe on it.
// With --groceries, ryan has Grocery autopilot, a Pancakes recipe and a
// Shopping list (Eggs, Coffee), and his Kroger account is connected to a
// store; the stand-ins for Kroger and Instacart find flour, eggs and milk,
// and take any cart or list.
// ryan has Sweep, and he and sam are in a room "Plans" where sam asked about
// dinner. The stand-in for Claude suggests that dinner from the first message
// it's shown.
import http from "node:http";
import worker from "../../src/worker.js";
import { Browser, makeEnv, sqlOne, run, grantApps } from "../../tests/helpers.mjs";
import { FakeMatrix } from "../../tests/fake-matrix.mjs";
import { b64url } from "../../src/crypto.js";

const hs = new FakeMatrix().install();
hs.room("!fam:matrix.test", { name: "Family", members: { "@ryan:matrix.test": "Ryan", "@sam:matrix.test": "Sam" } });
hs.say("!fam:matrix.test", "@sam:matrix.test", "dinner at six?");
hs.invite("!club:matrix.test", "@kim:matrix.test", { name: "Book club", members: { "@kim:matrix.test": "Kim" } });

const notify = process.argv.includes("--notify");
let vapid = {};
if (notify) {
  const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  vapid = { VAPID_PUBLIC_KEY: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey))),
            VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey("jwk", k.privateKey)).d };
  const matrix = globalThis.fetch;
  globalThis.fetch = (input, init) => new URL(input.url || input).host === "fcm.googleapis.com"
    ? Promise.resolve(new Response(null, { status: 201 })) : matrix(input, init);
}
{
  const before = globalThis.fetch;
  const PANCAKES = `<html><head><script type="application/ld+json">${JSON.stringify({ "@type": "Recipe", name: "Pancakes",
    recipeYield: "4 servings", totalTime: "PT20M", recipeIngredient: ["1 1/2 cups flour", "2 eggs", "1 cup milk", "salt to taste"],
    recipeInstructions: [{ "@type": "HowToStep", text: "Mix." }, { "@type": "HowToStep", text: "Cook." }] })}</script></head></html>`;
  globalThis.fetch = (input, init) => {
    const u = new URL(input.url || input);
    if (u.host !== "recipes.test") return before(input, init);
    return Promise.resolve(new Response(u.pathname === "/pancakes" ? PANCAKES : "<title>A blog</title>", { headers: { "Content-Type": "text/html" } }));
  };
}
{
  const before = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = new URL(input.url || input);
    if (u.host !== "api.anthropic.com") return before(input, init);
    if (u.pathname === "/v1/models") return new Response("{}");  // checking a key: any will do
    const first = JSON.parse(init.body).messages[0].content.match(/^\[(\d+)\]/m);
    const suggestions = first ? [{ kind: "event", title: "Dinner at Lucia's", start: "2030-01-04T19:00", end: "", collection: "",
      quote: "dinner at Lucia's", message: Number(first[1]), confidence: 0.9, why: "A plan with a time." }] : [];
    return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ suggestions }) }] }));
  };
}
const groceries = process.argv.includes("--groceries");
let stores = {};
if (groceries) {
  stores = { KROGER_CLIENT_ID: "devsite", KROGER_CLIENT_SECRET: "devsite-secret", INSTACART_API_KEY: "devsite-instacart" };
  const before = globalThis.fetch;
  const product = (upc, description, size, price) => ({ productId: upc, upc, description, brand: "Kroger", items: [{ size, price: { regular: price } }] });
  const PRODUCTS = {
    flour: [product("0001111000001", "Kroger All Purpose Flour", "5 lb", 2.99), product("0001111000002", "Gold Medal Flour", "5 lb", 4.29)],
    egg: [product("0001111000003", "Kroger Large Eggs", "12 ct", 3.49)],
    milk: [product("0001111000004", "Kroger 2% Milk", "1 gal", 3.19)],
  };
  const STORE = { locationId: "01400943", chain: "KROGER", name: "Kroger - Main St", address: { addressLine1: "1 Main St", city: "Cincinnati", state: "OH", zipCode: "45202" } };
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(input.url || input);
    if (u.host === "connect.instacart.com") return Response.json({ products_link_url: "https://customers.instacart.com/store/shopping_lists/devsite" });
    if (u.host !== "api.kroger.com") return before(input, init);
    if (u.pathname === "/v1/connect/oauth2/token") return Response.json({ access_token: "devsite-token", refresh_token: "devsite-refresh", expires_in: 1800 });
    if (u.pathname === "/v1/locations") return Response.json({ data: [STORE, { ...STORE, locationId: "01400944", name: "Kroger - Vine St", address: { ...STORE.address, addressLine1: "9 Vine St" } }] });
    if (u.pathname.startsWith("/v1/locations/")) return Response.json({ data: { ...STORE, locationId: u.pathname.split("/").pop() } });
    if (u.pathname === "/v1/products") {
      const words = (u.searchParams.get("filter.term") || "").toLowerCase().split(/\s+/).map(w => w.replace(/s$/, ""));
      return Response.json({ data: PRODUCTS[words.find(w => PRODUCTS[w])] ?? [] });
    }
    if (u.pathname === "/v1/cart/add") return new Response(null, { status: 204 });
    return new Response("{}", { status: 404 });
  };
}
const env = makeEnv({ CHAT_BRIDGE_KEY: "devsite-bridge-key-0123456789", ...vapid, ...stores });
const ryan = new Browser(env), sam = new Browser(env);
await ryan.signup("ryan", undefined, "Ryan M");
await sam.signup("sam", undefined, "Sam");
for (const who of ["ryan", "sam"]) grantApps(env, who, "plugins", "chat");
grantApps(env, "ryan", "chat-bridges", "recipes", "sweep");
{
  const plans = (await ryan.req("POST", "/chat/api/rooms", { json: { name: "Plans" } })).json.id;
  await sam.req("POST", `/chat/api/rooms/${plans}/join`);
  await sam.req("POST", `/chat/api/rooms/${plans}/messages`, { json: { body: "dinner at Lucia's on Friday at 7?" } });
}
const id = name => sqlOne(env, "SELECT id FROM users WHERE username = ?", name).id;

if (groceries) {
  grantApps(env, "ryan", "groceries");
  await ryan.req("POST", "/recipes/api/recipes", { json: { title: "Pancakes", yield: "4 servings",
    ingredients: ["1 1/2 cups flour", "2 eggs", "1 cup milk", "salt to taste"] } });
  const list = (await ryan.req("POST", "/todo/api/collections", { json: { name: "Shopping list", plugins: ["checklist", "list"] } })).json;
  for (const title of ["Eggs", "Coffee"]) {
    await ryan.req("POST", "/todo/api/items", { json: { title, collection: list.id, meta: { checklist: { done: false, priority: 0 } } } });
  }
  const s = new URL((await ryan.get("/groceries/kroger/connect")).location).searchParams.get("state");
  await ryan.get(`/groceries/kroger/callback?state=${s}&code=devsite`);
  await ryan.req("PUT", "/groceries/api/kroger/store", { json: { id: "01400943" } });
}

// sam's plugin, approved by an admin (made straight in the database).
const t = Math.floor(Date.now() / 1000);
run(env, "INSERT INTO store_plugins (id, owner, created_at) VALUES ('stars', ?, ?)", id("sam"), t);
run(env, `INSERT INTO store_versions (plugin_id, version, status, name, description, code, note, review_note, created_at, reviewed_at)
  VALUES ('stars', 1, 'approved', 'Stars', 'Rate items out of five.', 'export default { id: "stars", name: "Stars", clean: v => v };', '', '', ?, ?)`, t, t);

if (notify) {
  grantApps(env, "ryan", "notifications");
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const p256dh = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey)));
  const res = await ryan.req("POST", "/notifications/api/devices", { json: {
    endpoint: "https://fcm.googleapis.com/fcm/send/ryans-phone", keys: { p256dh, auth: b64url(crypto.getRandomValues(new Uint8Array(16))) },
    label: "Chrome on Android", tz: "America/New_York" } });
  if (res.status !== 201) throw new Error("couldn't add ryan's phone: " + res.text);
}

if (process.argv.includes("--admin")) {
  run(env, "INSERT INTO user_areas (user_id, area) VALUES (?, 'admin')", id("ryan"));
  run(env, "UPDATE users SET totp_secret = 'AAAAAAAAAAAAAAAA' WHERE id = ?", id("ryan"));
}

// Sign a terminal in the way `sintfoap login` does.
const term = new Browser(env);
const start = (await term.req("POST", "/login/cli/start", { json: { name: "tests" }, origin: null })).json;
await ryan.post("/login/cli", { code: start.user_code, confirm: "yes" });
const { token } = (await term.req("POST", "/login/cli/token", { json: { device_code: start.device_code }, origin: null })).json;

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  try {
    const out = await worker.fetch(new Request(`http://${req.headers.host}${req.url}`,
      { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }), env);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});
server.listen(0, "127.0.0.1", () => {
  console.log(JSON.stringify({ origin: `http://127.0.0.1:${server.address().port}`, token }));
});
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
