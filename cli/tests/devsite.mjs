// The site's real Worker (src/) over HTTP on localhost, with an in-memory
// database, for testing the terminal pages against the real APIs.
//
//   node cli/tests/devsite.mjs [--admin] [--notify] [--reviewed]
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
// ryan has Meal plan too (his Recipe box starts empty), and Pantry, with flour, soup and cumin in it
// (and sam's pantry, shared with him to use);
// any picture of a receipt reads as Walmart: flour, brown sugar, eggs and a bag.
// ryan has Sweep, and he and sam are in a room "Plans" where sam asked about
// dinner. The stand-in for Claude suggests that dinner from the first message
// it's shown, and reads every photo of a recipe as Nana's Shortbread (but turns
// down a key with "revoked" in it, as Anthropic does once a key is revoked).
// The weather (Open-Meteo) is the same everywhere: 16 days from today, with
// rain tomorrow and the day after the clear one; ryan is near London.
// ryan and sam have Trip planner, Recipe board, where sam shared Shortbread (Course: Dessert),
// and Food club, where sam picked last month (Pavlova).
// ryan and sam have Feedback; sam sent the admins "Pavlova cracked", linking that pick.
// --reviewed: ryan has Brownies in his Recipe box, shared on the board, and sam reviewed it
// (4 stars, "Fudgy.", with walnuts); ryan also typed Stew straight onto the board.
// Workers AI (the stand-in) translates the Spanish in WORDS below into English, line for line.
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
// Pantry's receipts (src/pantry_receipt.js), by Claude or Workers AI: any picture of one is this Walmart receipt.
const RECEIPT = { found: true, store: "Walmart", date: "", notes: "", lines: [
  { printed: "GV WW FLR 10LB", name: "Whole wheat flour", count: 1, size: "10 lb", food: true, price: 6.48 },
  { printed: "GV BRWN SUGAR 2LB", name: "Brown sugar", count: 1, size: "2 lb", food: true, price: 2.24 },
  { printed: "GV LG EGGS 12CT", name: "Eggs", count: 1, size: "12 ct", food: true, price: 3.12 },
  { printed: "BAG FEE", name: "Bag", count: 1, size: "", food: false, price: 0.1 },
] };
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
    // A key with "revoked" in it was turned off at Anthropic after it was added.
    if (/revoked/.test(new Headers(init.headers).get("x-api-key"))) return new Response('{"type":"error"}', { status: 401 });
    const said = JSON.parse(init.body).messages[0].content;
    if (/receipt/.test(JSON.parse(init.body).system || "")) return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(RECEIPT) }] }));
    if (Array.isArray(said)) return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({
      found: true, title: "Nana's Shortbread", servings: 0, yield: "Makes 24", time: "45 min",
      ingredients: ["2 cups flour", "1 cup butter", "1/2 cup sugar"], steps: ["Cream the butter and sugar.", "Add the flour.", "Bake at 325°F for 20 min."],
      notes: "From Nana." }) }] }));
    const first = said.match(/^\[(\d+)\]/m);
    const suggestions = first ? [{ kind: "event", title: "Dinner at Lucia's", start: "2030-01-04T19:00", end: "", collection: "",
      quote: "dinner at Lucia's", message: Number(first[1]), confidence: 0.9, why: "A plan with a time." }] : [];
    return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ suggestions }) }] }));
  };
}
{
  const before = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = new URL(input.url || input);
    if (u.host !== "api.open-meteo.com") return before(input, init);
    const time = [...Array(16)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return d.toLocaleDateString("sv"); });
    const codes = time.map((_, i) => [3, 63, 0, 61][i % 4]);
    return Response.json({ daily: { time, weather_code: codes, temperature_2m_max: time.map(() => 18), temperature_2m_min: time.map(() => 9),
      precipitation_probability_max: codes.map(c => c >= 61 ? 80 : 10), precipitation_sum: codes.map(c => c >= 61 ? 5 : 0) } });
  };
}
// Workers AI, for "Translate to English" (src/translate.js): these Spanish lines, and nothing else.
const WORDS = { "Tortilla española": "Spanish omelette", "La de mi abuela, la mejor.": "My grandmother's, the best.",
  "4 huevos": "4 eggs", "3 patatas medianas": "3 medium potatoes", "1 cebolla": "1 onion", "Aceite de oliva": "Olive oil", "Sal": "Salt",
  "Pelar y cortar las patatas en láminas finas.": "Peel the potatoes and cut them into thin slices.",
  "Freír las patatas y la cebolla a fuego lento, 20 minutos.": "Fry the potatoes and onion over low heat, 20 minutes.",
  "Batir los huevos y mezclar.": "Beat the eggs and mix them in.", "Cuajar 3 minutos por cada lado.": "Set for 3 minutes on each side.",
  "Mejor tibia.": "Best served warm.", "Cena con la abuela": "Dinner with grandma",
  "Llevar el vino y el postre. Ella vive en la calle Mayor 12.": "Bring the wine and dessert. She lives at Calle Mayor 12." };
// And Recipe box's photos without a Claude key (src/recipe_photo.js): any picture is this card.
const AI = {
  async run(model, input) {
    if (/receipt/.test(input.messages[0].content)) return { response: RECEIPT };
    if (Array.isArray(input.messages.at(-1).content)) return { response: {
      found: true, title: "Nana's Shortbread", servings: 0, yield: "makes 24", time: "45 min",
      ingredients: ["2 cups flour", "1 cup butter, softened", "½ cup sugar", "pinch of salt"],
      steps: ["Cream butter & sugar till pale.", "Press in a 9x13 pan.", "Bake 325° 30-35 min."], notes: "Don't let them brown!" } };
    const fields = JSON.parse(input.messages.at(-1).content);
    const tr = v => Array.isArray(v) ? v.map(tr) : WORDS[v] ?? v;
    const out = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, tr(v)]));
    return { response: { language: JSON.stringify(out) === JSON.stringify(fields) ? "English" : "Spanish", fields: out } };
  },
};
const env = makeEnv({ CHAT_BRIDGE_KEY: "devsite-bridge-key-0123456789", AI, ...vapid });
const ryan = new Browser(env), sam = new Browser(env);
await ryan.signup("ryan", undefined, "Ryan M");
await sam.signup("sam", undefined, "Sam");
for (const who of ["ryan", "sam"]) grantApps(env, who, "plugins", "chat");
grantApps(env, "ryan", "chat-bridges", "recipes", "recipes-mcp", "meals", "pantry", "sweep");
// An API key for an AI agent (made on /account, with the password), for the settings page's keys card.
await ryan.post("/account/apikeys", { name: "my assistant", password: "correct horse battery" });
for (const who of ["ryan", "sam"]) grantApps(env, who, "trips", "board", "food");
// The label list (Recipe labels, which ryan keeps): Season (Fall, Summer), Cuisine (Irish, Spanish)
// and Course (Breakfast, Dessert). Its keys are the Recipe board's categories.
for (const [n, key, value] of [[1, "Season", "Fall"], [2, "Season", "Summer"], [3, "Cuisine", "Irish"], [4, "Cuisine", "Spanish"], [5, "Course", "Breakfast"], [6, "Course", "Dessert"]]) {
  run(env, "INSERT INTO recipe_labels (id, key, value, created) VALUES (?, ?, ?, ?)", `l_000000000${n}`, key, value, new Date().toISOString());
}
grantApps(env, "ryan", "labels");
{
  await sam.req("POST", "/board/api/posts", { json: { labels: ["l_0000000006"], title: "Shortbread", note: "Three ingredients!",
    recipe: { ingredients: ["2 cups flour", "1 cup butter", "1/2 cup sugar"], steps: ["Rub together", "Bake at 160C for 40 min"], servings: 12 } } });
}
if (process.argv.includes("--reviewed")) {
  const brownies = (await ryan.req("POST", "/recipes/api/recipes", { json: { title: "Brownies", ingredients: ["1 cup cocoa"], steps: ["Bake"] } })).json;
  const shared = (await ryan.req("POST", "/board/api/posts", { json: { recipe_id: brownies.id, labels: ["l_0000000006"] } })).json;
  await ryan.req("POST", "/board/api/posts", { json: { title: "Stew", recipe: { ingredients: ["1 lb beef"], steps: ["Simmer"] } } });
  await sam.req("PUT", `/board/api/posts/${shared.id}/reviews`, { json: { rating: 4, note: "Fudgy.", changes: "Added walnuts." } });
}
{
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
  await sam.req("POST", "/food/api/picks", { json: { month: d.toLocaleDateString("sv").slice(0, 7), title: "Pavlova", kind: "dessert",
    blurb: "Crisp outside, marshmallow inside.", recipe: { ingredients: ["4 egg whites", "1 cup sugar"], steps: ["Whisk", "Bake low and slow"] } } });
}
{
  grantApps(env, "ryan", "feedback");
  grantApps(env, "sam", "feedback");
  const pick = sqlOne(env, "SELECT id FROM food_picks").id;
  await sam.req("POST", "/feedback/api/items", { json: { kind: "question", subject: "Pavlova cracked", message: "Mine cracked all over. Is that the oven?",
    links: [{ app: "food", id: pick }] } });
}
for (const item of [{ name: "Whole wheat flour", amount: "10 lb", low: "2 lb" }, { name: "Tomato soup", amount: 2, size: "16 oz" }, { name: "Ground cumin", level: 2 }]) {
  await ryan.req("POST", "/pantry/api/items", { json: item });
}
// sam shares his pantry (oat milk) with ryan, to use.
grantApps(env, "sam", "pantry");
await sam.req("POST", "/pantry/api/items", { json: { name: "Oat milk", kind: "counted", amount: 2, unit: "carton" } });
await sam.req("PUT", "/pantry/api/shares", { json: { username: "ryan", role: "use" } });
{
  const plans = (await ryan.req("POST", "/chat/api/rooms", { json: { name: "Plans" } })).json.id;
  await sam.req("POST", `/chat/api/rooms/${plans}/join`);
  await sam.req("POST", `/chat/api/rooms/${plans}/messages`, { json: { body: "dinner at Lucia's on Friday at 7?" } });
}
const id = name => sqlOne(env, "SELECT id FROM users WHERE username = ?", name).id;

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
    const request = new Request(`http://${req.headers.host}${req.url}`,
      { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
    Object.defineProperty(request, "cf", { value: { latitude: "51.5072", longitude: "-0.1276" } });
    const out = await worker.fetch(request, env);
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
