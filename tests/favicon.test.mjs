// The browser tab icon: every page links it, and the files it points at exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { Browser, makeEnv } from "./helpers.mjs";

const ICON = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';
const pub = p => new URL(`../public/${p}`, import.meta.url);

test("every page shows the site's tab icon", async () => {
  for (const f of ["favicon.svg", "favicon.ico", "icons/apple-touch-icon.png"]) assert.ok(existsSync(pub(f)), f);
  // The sandbox frame is never a tab of its own, so it goes without.
  for (const page of ["index.html", "friends/index.html", "chat/index.html", "notifications/index.html", "plugins/index.html", "todo/index.html"]) {
    assert.ok(readFileSync(pub(page), "utf8").includes(ICON), page);
  }
  const b = new Browser(makeEnv());
  assert.ok((await b.get("/login")).text.includes(ICON), "pages the Worker renders");
});
