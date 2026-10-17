// The site's real Worker (src/) over HTTP on localhost, with an in-memory
// database, for testing the terminal pages against the real APIs.
//
//   node cli/tests/devsite.mjs [--admin]
//
// Prints one line of JSON, {origin, token}: a terminal session for "ryan"
// (made through the same code-approval flow `sintfoap login` uses), then
// serves until it's stopped. "sam" has an approved plugin, "stars", in the store.
// ryan can connect Matrix, to a stand-in homeserver (tests/fake-matrix.mjs) at
// matrix.test with the token syt_good, where he's in one room, "Family".
import http from "node:http";
import worker from "../../src/worker.js";
import { Browser, makeEnv, sqlOne, run, grantApps } from "../../tests/helpers.mjs";
import { FakeMatrix } from "../../tests/fake-matrix.mjs";

const hs = new FakeMatrix().install();
hs.room("!fam:matrix.test", { name: "Family", members: { "@ryan:matrix.test": "Ryan", "@sam:matrix.test": "Sam" } });
hs.say("!fam:matrix.test", "@sam:matrix.test", "dinner at six?");

const env = makeEnv({ CHAT_BRIDGE_KEY: "devsite-bridge-key-0123456789" });
const ryan = new Browser(env), sam = new Browser(env);
await ryan.signup("ryan", undefined, "Ryan M");
await sam.signup("sam", undefined, "Sam");
for (const who of ["ryan", "sam"]) grantApps(env, who, "plugins", "chat");
grantApps(env, "ryan", "chat-bridges");
const id = name => sqlOne(env, "SELECT id FROM users WHERE username = ?", name).id;

// sam's plugin, approved by an admin (made straight in the database).
const t = Math.floor(Date.now() / 1000);
run(env, "INSERT INTO store_plugins (id, owner, created_at) VALUES ('stars', ?, ?)", id("sam"), t);
run(env, `INSERT INTO store_versions (plugin_id, version, status, name, description, code, note, review_note, created_at, reviewed_at)
  VALUES ('stars', 1, 'approved', 'Stars', 'Rate items out of five.', 'export default { id: "stars", name: "Stars", clean: v => v };', '', '', ?, ?)`, t, t);

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
