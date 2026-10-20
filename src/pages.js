// Server-rendered pages for signing in and managing accounts. Every action is
// a plain form post; the only script is /keys.js, the site's shortcut keys.

import { siteNav } from "./nav.js";

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
  "img-src 'self' data:", "manifest-src 'self'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'",
].join("; ");

export function html(body, { status = 200, headers = {} } = {}) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", ...headers,
    },
  });
}

const CREST = `<svg viewBox="0 0 120 120" width="54" height="54" aria-hidden="true"><circle cx="60" cy="60" r="54" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="60" cy="60" r="45" fill="none" stroke="currentColor" stroke-width="1"/><g transform="translate(60,66)" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"><line x1="-11" y1="-11" x2="11" y2="11"/><line x1="11" y1="-11" x2="-11" y2="11"/><line x1="0" y1="-24" x2="0" y2="-2"/><line x1="-6" y1="-18" x2="6" y2="-18"/></g><path d="M 34 78 Q 44 66 60 66 Q 76 66 86 78 L 82 88 Q 71 78 60 78 Q 49 78 38 88 Z" fill="currentColor"/></svg>`;

// The rail's icons, 18px line drawings in the text colour.
const ICON = {
  home: `<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"/>`,
  todo: `<path d="M3 8c3-3 6 3 9 0s6-3 9 0M3 14c3-3 6 3 9 0s6-3 9 0"/>`,
  plugins: `<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M17.5 14v7M14 17.5h7"/>`,
  account: `<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>`,
  admin: `<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>`,
  chat: `<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/>`,
  recipes: `<path d="M6 3h11a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6z"/><path d="M6 3v18M9.5 8h5M9.5 11.5h5"/>`,
  sweep: `<path d="M4 20 14 10M12 8l4 4M14 6l4 4-3 3-4-4z"/><path d="M5 5v3M3.5 6.5h3M19 15v3M17.5 16.5h3"/>`,
  bell: `<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>`,
  out: `<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>`,
  fold: `<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M9 4v16M16 9l-3 3 3 3"/>`,
};
const icon = name => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

// The rail's own styles. Server pages include them in STYLE; withRail() sends
// them with the rail into static pages, which name their colours differently.
// Pages give the rail an `auto` column, so its own width sets the column's:
// 232px, or 60px of icons once it's folded (html.rail-min, from /rail.js).
const RAIL_CSS = `
  .rail { width: 232px; position: sticky; top: 0; height: calc(100vh - 38px); overflow-y: auto; display: flex; flex-direction: column; gap: 1px;
          padding: 20px 12px 16px; background: var(--rail); border-right: 1px solid var(--line); font-family: var(--mono); font-size: 14px; }
  .rail .brand { display: flex; align-items: center; gap: 10px; padding: 0 10px 20px; color: var(--gold); text-decoration: none; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; }
  .rail .brand svg { width: 22px; height: 22px; flex: none; }
  .rail h3 { margin: 16px 10px 4px; font: 400 11px var(--mono); letter-spacing: 3px; text-transform: uppercase; color: var(--faint); }
  .rail .go { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-left: 2px solid transparent; color: var(--muted); text-decoration: none; }
  .rail .go svg { color: var(--faint); flex: none; width: 16px; height: 16px; }
  .rail .go kbd { margin-left: auto; font: 700 11px var(--mono); color: var(--gold); border: 0; background: none; padding: 0; }
  .rail .go:hover { background: var(--gold-soft); color: var(--ink); }
  .rail .go[aria-current="page"] { background: var(--gold-soft); border-left-color: var(--gold); color: var(--ink); font-weight: 700; }
  .rail .go[aria-current="page"] svg { color: var(--gold); }
  .rail button.go { width: 100%; margin: auto 0 0; background: none; border: 0; border-left: 2px solid transparent; cursor: pointer;
          color: var(--muted); font: 400 14px var(--mono); letter-spacing: 0; text-transform: none; text-align: left; filter: none; }
  .rail button.go::before, .rail button.go::after { content: none; }
  .rail .me { padding: 14px 10px 0; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--muted); display: grid; gap: 2px; }
  .rail .me b, .rail .me .mono { color: var(--ink); font-weight: 700; overflow-wrap: anywhere; }
  .rail .me a { color: var(--gold); text-decoration: none; justify-self: start; margin-top: 6px; }
  .rail .me a svg { display: none; }
  @media (min-width: 821px) {
    .rail-min .rail { width: 60px; padding-inline: 8px; overflow-x: hidden; }
    .rail-min .rail .brand { justify-content: center; padding: 0 0 20px; }
    .rail-min .rail .brand span, .rail-min .rail .go span, .rail-min .rail .go kbd, .rail-min .rail .me b, .rail-min .rail .me span { display: none; }
    .rail-min .rail h3 { height: 1px; margin: 12px 6px; overflow: hidden; color: transparent; background: var(--line); }
    .rail-min .rail .go { justify-content: center; padding: 8px 0; }
    .rail-min .rail .go svg { width: 18px; height: 18px; }
    .rail-min .rail button.go svg { transform: scaleX(-1); }
    .rail-min .rail .me { padding: 12px 0 0; justify-items: center; }
    .rail-min .rail .me a { margin: 0; padding: 4px; }
    .rail-min .rail .me a svg { display: block; }
  }
  @media (max-width: 820px) {
    .rail { width: auto; position: static; height: auto; flex-direction: row; align-items: center; gap: 2px; padding: 8px 10px; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--line); }
    .rail .brand { padding: 0 8px 0 4px; }
    .rail .brand span, .rail h3, .rail .me b, .rail .me span, .rail .go kbd, .rail .go span { display: none; }
    .rail .go[aria-current="page"] span { display: inline; }
    .rail .go { white-space: nowrap; padding: 6px 9px; border-left: 0; border-bottom: 2px solid transparent; }
    .rail .go[aria-current="page"] { border-bottom-color: var(--gold); }
    .rail button.go { display: none; }
    .rail .me { margin: 0 0 0 auto; padding: 0; border: 0; }
    .rail .me a { margin: 0; white-space: nowrap; }
    .rail .me a span { display: inline; }
  }
`;

// The server pages' frame: the rail beside the page, the key bar under both.
const SHELL_CSS = `
  .shell { display: grid; grid-template-columns: auto minmax(0, 1fr); min-height: 100vh; padding-bottom: 38px; }
  .page { padding: 34px clamp(16px, 3vw, 40px) 56px; min-width: 0; }
  .page > * { max-width: 600px; }
  .page.wide > * { max-width: none; }
  kbd { font: 700 11px var(--mono); color: var(--gold); }
  .keybar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 5; height: 38px; display: flex; align-items: center; gap: 22px; overflow-x: auto;
            padding: 0 max(16px, env(safe-area-inset-right, 0px)) 0 max(16px, env(safe-area-inset-left, 0px)); white-space: nowrap;
            background: var(--rail); border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; scrollbar-width: none; }
  .keybar a { color: var(--muted); text-decoration: none; }
  .keybar a:hover { color: var(--ink); }
  .keybar kbd { font-size: 13px; margin-right: 6px; }
  .keybar .end { margin-left: auto; }
  @media (max-width: 820px) {
    .shell { grid-template-columns: 1fr; padding-bottom: 0; }
    .page { padding-top: 26px; }
    .keybar { display: none; }
  }
${RAIL_CSS}`;

// Console: the terminal dashboard's look in the browser. Monospace type,
// square double-ruled panels, gold on green-black, and a key bar along the
// bottom. Dark uses the terminal UI's own colours (cli/sintfoap/look.py);
// light is the same screen on paper.
const STYLE = `
  :root { color-scheme: light;
          --bg:#f2f0e6; --rail:#ebe8dc; --panel:#fbfaf4; --field:#ffffff; --line:#cfc9b0; --line-2:#a9a283;
          --gold:#8a6510; --gold-soft:#e9e1c2; --on-gold:#fbf7ea; --ink:#1c1d16; --muted:#4d4c3f; --faint:#7a7764;
          --bad:#b4412f; --good:#2f7a52; --warn:#946c0c; --mono:'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace; }
  @media (prefers-color-scheme: dark) { :root { color-scheme: dark;
          --bg:#0b0f0a; --rail:#0e140e; --panel:#121a12; --field:#0e140e; --line:#4a4430; --line-2:#6a6243;
          --gold:#d6ae5e; --gold-soft:#24251a; --on-gold:#1a1206; --ink:#f4efe6; --muted:#c6bcab; --faint:#8a8270;
          --bad:#e47a62; --good:#7fcf98; --warn:#e0b25a; } }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body { min-height: 100vh; background: var(--bg); color: var(--ink); font: 400 14px/1.6 var(--mono); -webkit-font-smoothing: antialiased; }
  a { color: var(--gold); }
  :focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
  ::selection { background: var(--gold); color: var(--on-gold); }

  /* signed out: one centred column */
  .solo { max-width: 480px; margin: 0 auto; padding: 32px 16px 64px; }
  .solo .crest { display: flex; align-items: center; gap: 10px; margin-bottom: 40px; color: var(--gold); text-decoration: none; font-weight: 700; letter-spacing: 1px; }
  .solo .crest svg { width: 30px; height: 30px; }

${SHELL_CSS}
  .kicker { font: 700 13px var(--mono); letter-spacing: .55em; color: var(--gold); text-transform: uppercase; }
  h1 { font: 700 clamp(22px, 4vw, 30px)/1.25 var(--mono); margin: 10px 0 20px; text-wrap: balance; overflow-wrap: anywhere; }
  h2 { font: 700 15px/1.4 var(--mono); margin: 0 0 10px; color: var(--ink); }
  p { color: var(--muted); margin: 0 0 12px; }
  .lede { margin: -8px 0 24px; }
  .card { position: relative; background: var(--panel); border: 1px solid var(--line); padding: 22px 24px; margin-bottom: 18px; }
  .card::before { content: ""; position: absolute; inset: 4px; border: 1px solid var(--line); pointer-events: none; }
  .card > * { position: relative; }
  .card > :last-child { margin-bottom: 0; }
  .card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 10px; }
  .card-head h2 { margin: 0; }
  .card-head a { font-size: 12px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; text-decoration: none; white-space: nowrap; }
  label { display: block; font: 400 12px var(--mono); letter-spacing: 1.5px; color: var(--muted); text-transform: uppercase; margin: 14px 0 6px; }
  input[type=text], input[type=password], input[type=email], select { width: 100%; padding: 9px 11px; font: 15px var(--mono); color: var(--ink);
          background: var(--field); border: 1px solid var(--line-2); border-radius: 0; }
  input:focus, select:focus { outline: 2px solid var(--gold); outline-offset: 1px; }
  .hint { font-size: 12.5px; color: var(--faint); margin: 6px 0 0; }
  button, .btn { display: inline-block; margin-top: 18px; padding: 8px 16px; font: 700 12.5px var(--mono); letter-spacing: 1.5px; text-transform: uppercase;
          color: var(--on-gold); background: var(--gold); border: 1px solid var(--gold); border-radius: 0; cursor: pointer; text-decoration: none; }
  button::before, .btn::before { content: "[ "; } button::after, .btn::after { content: " ]"; }
  button:hover, .btn:hover { filter: brightness(1.08); }
  button.quiet, .btn.quiet { background: transparent; color: var(--gold); border-color: var(--line-2); }
  button.danger { background: transparent; color: var(--bad); border-color: color-mix(in oklch, var(--bad) 50%, transparent); }
  button.small { margin-top: 0; padding: 3px 8px; font-size: 11px; letter-spacing: .5px; }
  button.small::before, button.small::after { content: none; }
  .msg { padding: 10px 14px; margin-bottom: 18px; border-left: 3px solid; }
  .msg.bad { background: color-mix(in oklch, var(--bad) 10%, transparent); border-color: var(--bad); color: var(--bad); }
  .msg.good { background: color-mix(in oklch, var(--good) 10%, transparent); border-color: var(--good); color: var(--ink); }
  .alt { margin-top: 22px; color: var(--muted); }
  .qr { background: #fff; padding: 12px; width: 220px; }
  .qr svg { display: block; width: 100%; height: auto; }
  code, .mono { font-family: var(--mono); word-break: break-all; color: var(--ink); font-weight: 700; }
  .codes { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 18px; font-size: 15px; color: var(--ink); }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th, td { text-align: left; padding: 10px 8px; border-bottom: 1px dashed var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  th { font: 400 11px var(--mono); letter-spacing: 1.5px; text-transform: uppercase; color: var(--faint); border-bottom-style: solid; }
  td form { display: inline-block; margin: 0 6px 6px 0; }
  .tag { display: inline-block; padding: 0 6px; border: 1px solid var(--line-2); font-size: 11.5px; margin: 0 4px 4px 0; color: var(--muted); }
  .tag.off { color: var(--bad); border-color: currentColor; }
  .tag.on { color: var(--good); border-color: currentColor; }
  .tag.warn { color: var(--warn); border-color: currentColor; }
  .row { display: flex; gap: 10px; align-items: end; flex-wrap: wrap; }
  .row > * { flex: 1; min-width: 140px; }
  .row button { flex: 0; }
  .scroll { overflow-x: auto; }

  /* dashboard */
  .home { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 18px; align-items: start; }
  @media (max-width: 1000px) { .home { grid-template-columns: 1fr; } }
  .agenda { list-style: none; margin: 0; padding: 0; }
  .agenda li { display: grid; grid-template-columns: 3ch minmax(0, 1fr) auto; gap: 10px; align-items: baseline; padding: 7px 0; border-top: 1px dashed var(--line); }
  .agenda li:first-child { border-top: 0; }
  .agenda .box::before { content: "[ ]"; color: var(--faint); }
  .agenda .t { color: var(--ink); overflow-wrap: anywhere; }
  .agenda .when { font-size: 12.5px; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .agenda .late .when { color: var(--bad); }
  .agenda .more { color: var(--faint); font-size: 12.5px; display: block; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(90px, 1fr)); gap: 10px; margin-bottom: 14px; }
  .stat { border: 1px solid var(--line); padding: 8px 12px; }
  .stat b { display: block; font: 700 24px/1.2 var(--mono); color: var(--gold); font-variant-numeric: tabular-nums; }
  .stat span { display: block; font-size: 12px; line-height: 1.3; color: var(--muted); }
  .checks { list-style: none; margin: 0 0 4px; padding: 0; display: grid; gap: 6px; }
  .checks li { display: flex; gap: 10px; align-items: baseline; color: var(--muted); }
  .checks li::before { content: "✓"; color: var(--good); font-weight: 700; flex: none; }
  .checks li.warn::before { content: "!"; color: var(--warn); }
  .checks li a { margin-left: auto; font-size: 12.5px; white-space: nowrap; }
  .apps { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; margin-top: 8px; }
  a.app { position: relative; display: flex; flex-direction: column; gap: 6px; text-decoration: none; color: var(--ink); background: var(--panel); border: 1px solid var(--line); padding: 18px 20px; }
  a.app::before { content: ""; position: absolute; inset: 4px; border: 1px solid var(--line); pointer-events: none; }
  a.app:hover, a.app:focus-visible { outline: none; border-color: var(--gold); }
  a.app:hover::before, a.app:focus-visible::before { border-color: var(--gold); }
  a.app .name { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 15px; }
  a.app .name svg { color: var(--gold); width: 16px; height: 16px; }
  a.app p { margin: 0; font-size: 13.5px; }
  a.app .open { margin-top: 8px; font-size: 12px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: var(--gold); }
  .section-title { font-size: 11px; letter-spacing: 3px; text-transform: uppercase; color: var(--faint); margin: 26px 0 0; }

  /* settings: sections with their own sub-nav */
  .settings { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 32px; align-items: start; }
  .settings > * { min-width: 0; }
  .subnav { position: sticky; top: 24px; display: grid; gap: 1px; }
  .subnav a { padding: 5px 10px; border-left: 2px solid var(--line); color: var(--muted); text-decoration: none; font-size: 13px; }
  .subnav a:hover { color: var(--ink); border-left-color: var(--gold); }
  .settings section { scroll-margin-top: 24px; }
  .settings .group { font-size: 11px; letter-spacing: 3px; text-transform: uppercase; color: var(--faint); margin: 8px 0 10px; }
  @media (max-width: 820px) { .settings { grid-template-columns: 1fr; gap: 12px; } .subnav { position: static; display: flex; flex-wrap: wrap; gap: 6px; }
    .subnav a { border: 1px solid var(--line); padding: 3px 10px; } }
  /* admin: one switch per app per account */
  .toggles { display: grid; gap: 4px; min-width: 170px; }
  .toggles form { margin: 0; }
  button.toggle { margin: 0; padding: 2px 8px 2px 4px; display: flex; align-items: center; gap: 8px; width: 100%; background: transparent; border: 0;
          color: var(--muted); font: 400 13px var(--mono); letter-spacing: 0; text-transform: none; text-align: left; white-space: nowrap; }
  button.toggle::before { content: ""; flex: none; width: 26px; height: 14px; border: 1px solid var(--line-2); border-radius: 8px;
          background: radial-gradient(circle at 6px 50%, var(--faint) 4px, transparent 5px); }
  button.toggle::after { content: "off"; margin-left: auto; font-size: 11px; color: var(--faint); }
  button.toggle[aria-pressed="true"] { color: var(--ink); }
  button.toggle[aria-pressed="true"]::before { border-color: var(--gold); background: var(--gold-soft) radial-gradient(circle at 18px 50%, var(--gold) 4px, transparent 5px); }
  button.toggle[aria-pressed="true"]::after { content: "on"; color: var(--gold); }
  button.toggle:disabled { cursor: default; filter: none; opacity: .7; }
  .admin-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-bottom: 18px; }
`;

// The tab icon, web app manifest and home-screen icon, so the site can be added to a
// phone's home screen (on iPhone, that's what lets it get notifications).
export const APP_HEAD = `<link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="manifest" href="/site.webmanifest"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">`;

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">`;

// The rail, from siteNav(): the same on every signed-in page. `here` is the
// id of the current page's entry ("home", "drift", "plugins", "chat",
// "notifications", "account", "admin").
export function rail(user, here) {
  const nav = siteNav(user);
  const link = n => `<a class="go" href="${esc(n.href)}" data-key="${n.key}" aria-label="${esc(n.label)}" title="${esc(n.label)}"${here === n.id ? ` aria-current="page"` : ""}>${icon(n.icon)}<span>${esc(n.label)}</span><kbd aria-hidden="true">g ${n.key}</kbd></a>`;
  // /rail.js runs before the rail is drawn, so a folded rail never flashes open.
  return `<script src="/rail.js"></script><nav class="rail" aria-label="Site">
    <a class="brand" href="/" aria-label="sintfoap.xyz home">${CREST}<span>sintfoap</span></a>
    ${nav.filter(n => n.group === "site").map(link).join("")}
    <h3>Account</h3>
    ${nav.filter(n => n.group === "account").map(link).join("")}
    <button type="button" class="go" data-rail-fold aria-label="Collapse sidebar" title="Collapse sidebar">${icon("fold")}<span>Collapse</span><kbd aria-hidden="true">\\</kbd></button>
    <div class="me"><b>${esc(user.display_name)}</b><span class="mono">${esc(user.username)}</span><a href="/logout" title="Sign out">${icon("out")}<span>Sign out</span></a></div>
  </nav>`;
}

// Puts the rail into a static page (Drift, the plugin store, chat) at its
// <!--site-rail--> marker, with the rail's styles mapped onto that page's own
// colour names so it follows the page's theme toggle too.
export async function withRail(res, user, here) {
  if (!(res.headers.get("Content-Type") || "").startsWith("text/html")) return res;
  const text = await res.text();
  const headers = new Headers(res.headers);
  for (const h of ["Content-Length", "ETag", "Last-Modified"]) headers.delete(h);
  headers.set("Cache-Control", "no-store");
  const style = `<style>.rail { --rail: var(--surface); --gold: var(--accent); --gold-soft: var(--accent-soft); --mono: var(--sans); }${RAIL_CSS}</style>`;
  return new Response(text.replace("<!--site-rail-->", style + rail(user, here)), { status: res.status, headers });
}

export function page(title, body, { user, wide = false, here = "" } = {}) {
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · sintfoap.xyz</title><meta name="robots" content="noindex">${FONTS}${APP_HEAD}
<style>${STYLE}</style></head><body>`;
  if (!user) return `${head}<div class="solo"><a class="crest" href="/" aria-label="sintfoap.xyz home">${CREST}<span>SINTFOAP.XYZ</span></a><main>${body}</main></div></body></html>`;
  return `${head}<div class="shell">${rail(user, here)}<main class="page${wide ? " wide" : ""}">${body}</main></div>
<footer class="keybar" aria-label="Keyboard shortcuts"><span><kbd>g</kbd>then a key from the menu to jump</span><span><kbd>\\</kbd>sidebar</span><span><kbd>tab</kbd>move</span><span><kbd>↵</kbd>open</span><a class="end" href="/logout" data-key="o"><kbd>g o</kbd>Sign out</a></footer>
<script src="/keys.js" defer></script></body></html>`;
}

const msg = (text, kind = "bad") => text ? `<div class="msg ${kind}" role="${kind === "bad" ? "alert" : "status"}">${esc(text)}</div>` : "";
const hiddenNext = next => next ? `<input type="hidden" name="next" value="${esc(next)}">` : "";

export const loginPage = ({ error, next, username = "", signupsOpen }) => page("Sign in", `
  <div class="kicker">sintfoap.xyz</div><h1>Sign in</h1>
  <form method="post" action="/login" class="card">${msg(error)}${hiddenNext(next)}
    <label for="u">Username</label><input id="u" type="text" name="username" value="${esc(username)}" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
    <label for="p">Password</label><input id="p" type="password" name="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
  </form>
  <p class="alt"><a href="/login/forgot">Forgot your username or password?</a></p>
  ${signupsOpen ? `<p class="alt">New here? <a href="/signup${next ? `?next=${encodeURIComponent(next)}` : ""}">Create an account</a></p>` : ""}`);

export const signupPage = ({ error, next, values = {}, closed }) => page("Create an account", closed
  ? `<div class="kicker">sintfoap.xyz</div><h1>Create an account</h1>${msg(closed)}<p class="alt"><a href="/login">Back to sign in</a></p>`
  : `<div class="kicker">sintfoap.xyz</div><h1>Create an account</h1>
  <form method="post" action="/signup" class="card">${msg(error)}${hiddenNext(next)}
    <label for="u">Username</label><input id="u" type="text" name="username" value="${esc(values.username)}" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
    <p class="hint">3–32 characters: letters, numbers, - and _.</p>
    <label for="d">Display name</label><input id="d" type="text" name="display_name" value="${esc(values.display_name)}" autocomplete="nickname" maxlength="50">
    <p class="hint">What the site calls you. Defaults to your username.</p>
    <label for="p">Password</label><input id="p" type="password" name="password" autocomplete="new-password" minlength="12" maxlength="128" required>
    <p class="hint">At least 12 characters. A few random words works well.</p>
    <label for="p2">Password again</label><input id="p2" type="password" name="password2" autocomplete="new-password" required>
    <button type="submit">Create account</button>
  </form>
  <p class="alt">Already have one? <a href="/login${next ? `?next=${encodeURIComponent(next)}` : ""}">Sign in</a></p>`);

export const mfaPage = ({ error, next }) => page("Two-factor code", `
  <div class="kicker">sintfoap.xyz</div><h1>Enter your code</h1>
  <form method="post" action="/login/2fa" class="card">${msg(error)}${hiddenNext(next)}
    <label for="c">6-digit code from your authenticator app</label>
    <input id="c" type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="11" required autofocus>
    <p class="hint">Lost your phone? Enter one of your recovery codes instead.</p>
    <button type="submit">Continue</button>
  </form>
  <p class="alt"><a href="/logout">Start over</a></p>`);

export const forgotPage = ({ error, mail }) => page("Forgot username or password", `
  <div class="kicker">sintfoap.xyz</div><h1>Forgot your username or password?</h1>
  ${msg(error)}
  ${mail ? `<form method="post" action="/login/forgot/email" class="card">
    <h2>By email</h2>
    <p>If you confirmed an email address in your account settings, we'll send your username and a link to choose a new password.</p>
    <label for="e">Email</label><input id="e" type="email" name="email" autocomplete="email" autocapitalize="none" spellcheck="false" maxlength="254" required>
    <button type="submit">Email me a link</button>
  </form>` : ""}
  <form method="post" action="/login/forgot" class="card">
    ${mail ? `<h2>With a recovery code</h2>` : ""}
    <p>Use one of the recovery codes you saved from your account settings. It tells us which account is yours, so you don't need your username.</p>
    <label for="r">Recovery code</label>
    <input id="r" type="text" name="recovery_code" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="20" placeholder="xxxxx-xxxxx" required autofocus>
    <label for="a">Code from your authenticator app</label>
    <input id="a" type="text" name="app_code" inputmode="numeric" autocomplete="one-time-code" maxlength="6">
    <p class="hint">Only if you use two-factor. Leave it empty otherwise.</p>
    <label for="n">New password</label><input id="n" type="password" name="new_password" autocomplete="new-password" minlength="12" maxlength="128" required>
    <label for="n2">New password again</label><input id="n2" type="password" name="new_password2" autocomplete="new-password" required>
    <button type="submit">Reset password</button>
  </form>
  <p class="alt">${mail ? "No email or recovery codes" : "No recovery codes"}, or lost your phone too? Ask the site's admin to reset your password.</p>
  <p class="alt"><a href="/login">Back to sign in</a></p>`);

export const forgotDonePage = ({ user, recoveryLeft, usedRecoveryCode }) => page("Password reset", `
  <div class="kicker">sintfoap.xyz</div><h1>You're back in</h1>
  <div class="card">
    <p>Your username is <span class="mono">${esc(user.username)}</span>. Your password is changed, and every other device has been signed out.</p>
    ${usedRecoveryCode ? `<p>That recovery code is used up. You have ${recoveryLeft} left${recoveryLeft < 3 ? ", so make new ones in your account settings" : ""}.</p>` : ""}
    <a class="btn" href="/account">Go to your account</a>
  </div>`, { user });

export const forgotEmailSentPage = () => page("Check your email", `
  <div class="kicker">sintfoap.xyz</div><h1>Check your email</h1>
  <p>If that address is confirmed on an account here, we've sent it the username and a link to choose a new password. The link works once, for an hour.</p>
  <p>Nothing arriving? Check your spam folder, or use a recovery code instead.</p>
  <p class="alt"><a href="/login/forgot">Back</a> · <a href="/login">Sign in</a></p>`);

export const resetPage = ({ token, user, error }) => page("Choose a new password", `
  <div class="kicker">sintfoap.xyz</div><h1>Choose a new password</h1>
  <form method="post" action="/login/reset" class="card">${msg(error)}
    <input type="hidden" name="token" value="${esc(token)}">
    <p>Username <span class="mono">${esc(user.username)}</span></p>
    <input type="text" name="username" value="${esc(user.username)}" autocomplete="username" hidden>
    <label for="n">New password</label><input id="n" type="password" name="new_password" autocomplete="new-password" minlength="12" maxlength="128" required autofocus>
    <label for="n2">New password again</label><input id="n2" type="password" name="new_password2" autocomplete="new-password" required>
    ${user.totp_secret ? `<label for="c">Code from your authenticator app</label>
    <input id="c" type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="11" required>
    <p class="hint">Lost your phone? Enter one of your recovery codes instead.</p>` : ""}
    <button type="submit">Save password</button>
  </form>`);

export const changePasswordRequiredPage = ({ user, error }) => page("Choose a new password", `
  <div class="kicker">Account</div><h1>Choose a new password</h1>
  <p>Your password was reset. Pick a new one to continue.</p>
  <form method="post" action="/account/password" class="card">${msg(error)}
    <input type="hidden" name="forced" value="1">
    <label for="n">New password</label><input id="n" type="password" name="new_password" autocomplete="new-password" minlength="12" required autofocus>
    <label for="n2">New password again</label><input id="n2" type="password" name="new_password2" autocomplete="new-password" required>
    <button type="submit">Save password</button>
  </form>`, { user });

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// Home for a signed-in account: what's due in Drift, how the account is set
// up, and every app it can open. `agenda` is null for accounts without Drift.
export function dashboardPage({ user, apps, sessionCount, recoveryLeft, agenda, installs, mail, greeting, dateLabel }) {
  const first = String(user.display_name).split(/\s+/)[0];
  const appCards = apps.length
    ? `<div class="apps">${apps.map(a => `<a class="app" href="${esc(a.href)}"><span class="name">${icon(a.icon)}${esc(a.name)}</span><p>${esc(a.blurb)}</p><span class="open">Open →</span></a>`).join("")}</div>`
    : `<section class="card"><p>Your account doesn't have any apps yet. Ask the site's admin for access.</p></section>`;

  let summary = "", today = "";
  if (agenda) {
    const { late, due } = agenda, open = late.length + due.length;
    summary = open
      ? `${plural(due.length, "thing")} today in Drift${late.length ? `, and ${late.length} overdue` : ""}.`
      : "Nothing due today in Drift.";
    const li = (it, cls) => `<li class="${cls}"><span class="box" aria-hidden="true"></span><span class="t">${esc(it.title)}${it.collection ? ` <span class="more">${esc(it.collection)}</span>` : ""}</span><span class="when">${esc(it.when)}</span></li>`;
    const shown = [...late.map(it => li(it, "late")), ...due.map(it => li(it, ""))];
    today = `<section class="card"><div class="card-head"><h2>Today</h2><a href="/todo/">Open Drift →</a></div>
      ${shown.length ? `<ul class="agenda">${shown.slice(0, 8).join("")}</ul>${shown.length > 8 ? `<p class="hint">and ${shown.length - 8} more in Drift.</p>` : ""}`
        : `<p>Items with today's date, from any collection, show up here.</p>`}</section>`;
  }
  const checks = [
    user.totp_secret ? `<li>Two-factor is on</li>` : `<li class="warn">Two-factor is off <a href="/account#security">Set up</a></li>`,
    recoveryLeft >= 3 ? `<li>${plural(recoveryLeft, "recovery code")} left</li>`
      : `<li class="warn">${recoveryLeft ? `Only ${recoveryLeft} recovery code${recoveryLeft === 1 ? "" : "s"} left` : "No recovery codes"} <a href="/account#recovery">Make new</a></li>`,
    mail ? (user.email && user.email_verified ? `<li>Email confirmed for resets</li>`
      : `<li class="warn">${user.email ? "Email not confirmed yet" : "No email for resets"} <a href="/account#email">${user.email ? "Check" : "Add"}</a></li>`) : "",
  ].join("");
  const account = `<section class="card"><div class="card-head"><h2>Your account</h2><a href="/account">Settings →</a></div>
    <div class="stats"><div class="stat"><b>${sessionCount}</b><span>${sessionCount === 1 ? "device" : "devices"}</span></div>
      <div class="stat"><b>${recoveryLeft}</b><span>recovery codes</span></div>
      ${installs == null ? "" : `<div class="stat"><b>${installs}</b><span>${installs === 1 ? "plugin" : "plugins"}</span></div>`}</div>
    <ul class="checks">${checks}</ul>
    <p class="hint">Signed in as <span class="mono">${esc(user.username)}</span>.</p></section>`;

  return page("Dashboard", `
    <div class="kicker">${esc(dateLabel)}</div><h1>${esc(greeting)}, ${esc(first)}</h1>
    ${summary ? `<p class="lede">${summary}</p>` : ""}
    <div class="home">${today || `<div>${appCards}</div>`}${account}</div>
    ${today ? `<div class="section-title">Apps</div>${appCards}` : ""}`, { user, wide: true, here: "home" });
}

export function accountPage({ user, error, notice, recoveryLeft, sessionCount, setup, recoveryCodes, adminNeeds2fa, mail, apiKeys, newKey, keyNonce, origin }) {
  const isAdmin = user.areas.has("admin");
  let twofa;
  if (setup) {
    twofa = `<h2>Set up two-factor</h2>
      <p>Scan this with an authenticator app (Google Authenticator, 1Password, Authy…), then enter the 6-digit code it shows.</p>
      <div class="qr">${setup.qrSvg}</div>
      <p class="hint">Can't scan? Enter this key by hand: <span class="mono">${esc(setup.secret.replace(/(.{4})/g, "$1 ").trim())}</span></p>
      <form method="post" action="/account/2fa/confirm">
        <label for="c">Code from the app</label><input id="c" type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required autofocus>
        <button type="submit">Turn on two-factor</button>
      </form>
      <form method="get" action="/account"><button class="quiet" type="submit">Cancel</button></form>`;
  } else if (user.totp_secret) {
    twofa = `<h2>Two-factor is on</h2>
      <p>Signing in asks for a code from your phone after your password.</p>
      ${isAdmin ? `<p class="hint">Two-factor is required for admin accounts, so it can't be turned off here.</p>` : `
      <form method="post" action="/account/2fa/disable">
        <label for="dp">Password, to turn two-factor off</label><input id="dp" type="password" name="password" autocomplete="current-password" required>
        <button class="danger" type="submit">Turn off two-factor</button>
      </form>`}`;
  } else {
    twofa = `<h2>Two-factor is off</h2>
      <p>${adminNeeds2fa ? "Admin accounts need two-factor before they can use the rest of the site." : "Add a code from your phone on top of your password."}</p>
      <form method="post" action="/account/2fa/start">
        <label for="sp">Password</label><input id="sp" type="password" name="password" autocomplete="current-password" required>
        <button type="submit">Set up two-factor</button>
      </form>`;
  }
  const recovery = recoveryCodes ? `<h2>Save your recovery codes</h2>
      <p>Each one works once, to reset a forgotten password${user.totp_secret ? " or to sign in if you lose your phone" : ""}. They won't be shown again, so save them somewhere safe now, such as a password manager.</p>
      <div class="codes">${recoveryCodes.map(c => `<span>${esc(c)}</span>`).join("")}</div>
      <a class="btn" href="/account">I've saved them</a>`
    : `<h2>Recovery codes</h2>
      <p>${recoveryLeft
        ? `You have ${recoveryLeft} recovery code${recoveryLeft === 1 ? "" : "s"} left.`
        : "You have none, so if you forget your password only the admin can reset it."}
        A recovery code resets a forgotten password from the <a href="/login/forgot">forgot password</a> page${user.totp_secret ? ", along with a code from your phone" : ""}.</p>
      <form method="post" action="/account/recovery">
        <label for="rp">Password</label><input id="rp" type="password" name="password" autocomplete="current-password" required>
        <button class="${recoveryLeft ? "quiet" : ""}" type="submit">${recoveryLeft ? "Make new recovery codes" : "Make recovery codes"}</button>
        ${recoveryLeft ? `<p class="hint">This replaces the ones you have.</p>` : ""}
      </form>`;
  const when = t => t ? new Date(t * 1000).toISOString().slice(0, 10) : "never";
  const keys = apiKeys ? `<section class="card" id="apikeys"><h2>API keys</h2>
      ${newKey ? `<div class="msg good" role="status"><p>Key <strong>${esc(newKey.name)}</strong> is ready. Copy it now: it won't be shown again.</p>
        <p class="mono" style="word-break:break-all">${esc(newKey.key)}</p>
        <p>To add it to Claude Code:</p>
        <p class="mono" style="word-break:break-all">claude mcp add --transport http drift ${esc(origin)}/mcp --header "Authorization: Bearer ${esc(newKey.key)}"</p></div>` : ""}
      <p>Give an AI agent a key and it can use Drift as you: read and change your items and collections, share them, and add plugins. Treat a key like a password. Changing your password doesn't revoke keys; revoke them here. Setup instructions for the agent are in <a href="/llm.txt">llm.txt</a>. Its MCP address is <span class="mono">${esc(origin)}/mcp</span>.</p>
      ${apiKeys.length ? `<table><tr><th>Name</th><th>Key</th><th>Made</th><th>Last used</th><th></th></tr>${apiKeys.map(k => `<tr>
        <td>${esc(k.name)}</td><td class="mono">${esc(k.prefix)}…</td><td>${when(k.created_at)}</td><td>${when(k.last_used)}</td>
        <td><form method="post" action="/account/apikeys/revoke"><input type="hidden" name="id" value="${esc(k.id_hash)}"><button class="danger small" type="submit">Revoke</button></form></td></tr>`).join("")}</table>` : `<p class="hint">No keys yet.</p>`}
      <form method="post" action="/account/apikeys">
        <input type="hidden" name="nonce" value="${esc(keyNonce)}">
        <label for="kn">Name</label><input id="kn" type="text" name="name" maxlength="60" placeholder="e.g. my assistant" required>
        <label for="kp">Password</label><input id="kp" type="password" name="password" autocomplete="current-password" required>
        <button type="submit">Make a key</button>
      </form></section>` : "";
  const sections = [["security", "Two-factor"], ["recovery", "Recovery codes"], ...(mail ? [["email", "Email"]] : []),
    ["profile", "Profile"], ["password", "Password"], ["sessions", "Sessions"], ...(apiKeys ? [["apikeys", "API keys"]] : [])];
  return page("Account settings", `
    <div class="kicker">Account settings</div><h1>${esc(user.display_name)}</h1>
    ${msg(error)}${msg(notice, "good")}
    <div class="settings">
    <nav class="subnav" aria-label="Settings sections">${sections.map(([id, label]) => `<a href="#${id}">${label}</a>`).join("")}</nav>
    <div>
    ${recoveryCodes ? `<section class="card" id="recovery">${recovery}</section>` : ""}
    <div class="group">Security</div>
    <section class="card" id="security">${twofa}</section>
    ${recoveryCodes ? "" : `<section class="card" id="recovery">${recovery}</section>`}
    ${mail ? `<section class="card" id="email"><h2>Email</h2>
      <p>${user.email
        ? `<span class="mono">${esc(user.email)}</span> ${user.email_verified ? "is confirmed, so it can reset your password." : "isn't confirmed yet. Open the link we sent to it."}`
        : "Add an email address to get your username and a reset link if you forget your password. It's used for nothing else."}</p>
      <form method="post" action="/account/email">
        <label for="em">Email</label><input id="em" type="email" name="email" value="${esc(user.email)}" autocomplete="email" maxlength="254">
        <p class="hint">Leave it empty to remove your address.</p>
        <label for="ep">Password</label><input id="ep" type="password" name="password" autocomplete="current-password" required>
        <button type="submit">${user.email ? "Save email" : "Add email"}</button>
      </form></section>` : ""}
    <div class="group">You</div>
    <section class="card" id="profile"><h2>Profile</h2>
      <p>Username <span class="mono">${esc(user.username)}</span></p>
      <form method="post" action="/account/profile">
        <label for="dn">Display name</label><input id="dn" type="text" name="display_name" value="${esc(user.display_name)}" maxlength="50" required>
        <button type="submit">Save</button>
      </form></section>
    <section class="card" id="password"><h2>Password</h2>
      <form method="post" action="/account/password">
        <label for="cp">Current password</label><input id="cp" type="password" name="current_password" autocomplete="current-password" required>
        <label for="n">New password</label><input id="n" type="password" name="new_password" autocomplete="new-password" minlength="12" required>
        <label for="n2">New password again</label><input id="n2" type="password" name="new_password2" autocomplete="new-password" required>
        <button type="submit">Change password</button>
        <p class="hint">This also signs you out everywhere else.</p>
      </form></section>
    <section class="card" id="sessions"><h2>Sessions</h2>
      <p>Signed in on ${sessionCount} device${sessionCount === 1 ? "" : "s"}, including this one.</p>
      <form method="post" action="/account/sessions"><button class="quiet" type="submit">Sign out everywhere else</button></form></section>
    ${keys ? `<div class="group">Agents</div>${keys}` : ""}
    </div></div>`, { user, wide: true, here: "account" });
}

const date = t => new Date(t * 1000).toISOString().slice(0, 10);

export function adminPage({ user, users, orphans, apps, books = [], bookVotes = [], error, notice, tempPassword }) {
  const post = (action, label, fields, cls = "quiet small", confirm = "") =>
    `<form method="post" action="/admin/${action}">${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("")}${confirm}<button class="${cls}" type="submit">${label}</button></form>`;
  const rows = users.map(u => {
    const self = u.id === user.id;
    return `<tr><td><strong>${esc(u.display_name)}</strong><br><span class="mono">${esc(u.username)}</span><br><span class="hint">since ${date(u.created_at)}</span></td>
      <td><div class="toggles">${apps.map(a => {
        const on = u.areas.includes(a.area), locked = self && a.area === "admin";
        return `<form method="post" action="/admin/access"><input type="hidden" name="user_id" value="${esc(u.id)}"><input type="hidden" name="app" value="${esc(a.id)}"><input type="hidden" name="on" value="${on ? 0 : 1}">` +
          `<button class="toggle" type="submit" aria-pressed="${on}"${locked ? ` disabled title="You can't remove your own admin access."` : ""} aria-label="${esc(a.name)} for ${esc(u.username)}">${esc(a.name)}</button></form>`;
      }).join("")}</div></td>
      <td>${u.disabled ? `<span class="tag off">disabled</span>` : ""}${u.totp ? `<span class="tag on">2FA</span>` : ""}${u.must_change_pw ? `<span class="tag warn">must change pw</span>` : ""}<br><span class="hint">${u.sessions} session${u.sessions === 1 ? "" : "s"} · ${u.tasks} Drift item${u.tasks === 1 ? "" : "s"}</span></td>
      <td>${self ? `<span class="tag">you</span>` : [
        post(u.disabled ? "enable" : "disable", u.disabled ? "Enable" : "Disable", { user_id: u.id }, u.disabled ? "quiet small" : "danger small"),
        post("reset-password", "Reset password", { user_id: u.id }),
        u.totp ? post("reset-2fa", "Reset 2FA", { user_id: u.id }) : "",
        u.sessions ? post("signout", "Sign out", { user_id: u.id }) : "",
        post("delete", "Delete", { user_id: u.id }, "danger small", `<input type="text" name="confirm" placeholder="type ${esc(u.username)}" aria-label="Type the username to confirm" style="width:150px;padding:5px 8px;font-size:14px;margin-right:6px">`),
      ].join("")}</td></tr>`;
  }).join("");
  const orphanRows = orphans.length ? `<section class="card"><h2>Tasks with no account</h2>
    <p>These todo lists belong to an owner that isn't an account, such as lists made before this login existed. Move them to an account to give them back.</p>
    <table><tr><th>Owner</th><th>Tasks</th><th></th></tr>${orphans.map(o => `<tr><td class="mono">${esc(o.owner)}</td><td>${o.n}</td><td>
      <form method="post" action="/admin/move-tasks" class="row"><input type="hidden" name="from" value="${esc(o.owner)}">
        <select name="to" aria-label="Move to">${users.map(u => `<option value="${esc(u.id)}">${esc(u.username)}</option>`).join("")}</select>
        <button class="quiet small" type="submit">Move</button></form></td></tr>`).join("")}</table></section>` : "";
  const when = t => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const tally = books.map(b => `${esc(b.title)} <b>${bookVotes.filter(v => v.book === b.id).length}</b>`).join(" · ");
  const bookRows = `<section class="card scroll" id="book-votes"><h2>Book votes</h2>
    <p>Votes on the public <a href="/books/">/books</a> page, newest first. Browsers don't tell websites a computer's name, so each vote shows what the site could see: the name the voter typed (if any), their account if they were signed in, their address, browser and rough location. Votes from the terminal include the computer's name. One vote per browser; a cleared cookie or another browser can vote again.</p>
    <p class="hint">${tally}</p>
    ${bookVotes.length ? `<table><tr><th>Book</th><th>Who</th><th>Device</th><th>Address</th><th>When</th><th></th></tr>${bookVotes.map(v => `<tr>
      <td>${esc(v.title)}</td>
      <td>${v.name ? `<strong>${esc(v.name)}</strong>` : `<span class="hint">no name given</span>`}${v.username ? `<br><span class="mono">${esc(v.username)}</span>` : ""}</td>
      <td title="${esc(v.user_agent)}">${esc(v.device)}</td>
      <td><span class="mono">${esc(v.ip)}</span>${v.place ? `<br><span class="hint">${esc(v.place)}</span>` : ""}</td>
      <td>${when(v.updated_at)}${v.updated_at !== v.created_at ? `<br><span class="hint">first voted ${when(v.created_at)}</span>` : ""}</td>
      <td>${post("books/remove", "Remove", { voter: v.voter })}</td></tr>`).join("")}</table>` : `<p class="hint">No votes yet.</p>`}
  </section>`;
  return page("Admin", `
    <div class="kicker">Admin</div><h1>Accounts</h1>
    ${msg(error)}${msg(notice, "good")}
    <div class="admin-stats">
      <div class="stat"><b>${users.length}</b><span>${users.length === 1 ? "account" : "accounts"}</span></div>
      <div class="stat"><b>${users.filter(u => u.totp).length}</b><span>with two-factor</span></div>
      <div class="stat"><b>${users.reduce((n, u) => n + u.sessions, 0)}</b><span>signed-in devices</span></div>
      <div class="stat"><b>${users.filter(u => u.disabled).length}</b><span>disabled</span></div>
    </div>
    ${tempPassword ? `<div class="msg good">Temporary password for <strong>${esc(tempPassword.username)}</strong>: <span class="mono">${esc(tempPassword.password)}</span><br>Send it to them privately. They'll have to change it when they sign in, and it won't be shown again.</div>` : ""}
    <section class="card scroll"><table><tr><th>Account</th><th>Apps</th><th>Status</th><th>Actions</th></tr>${rows}</table></section>
    ${orphanRows}
    ${bookRows}`, { user, wide: true, here: "admin" });
}

export const adminClaimPage = ({ user, error, enabled }) => page("Become admin", `
  <div class="kicker">Admin</div><h1>Become the admin</h1>
  ${enabled ? `<p>No account is the admin yet. Enter the claim code from the site's Cloudflare settings to make this account (<span class="mono">${esc(user.username)}</span>) the admin.</p>
  <form method="post" action="/admin/claim" class="card">${msg(error)}
    <label for="c">Claim code</label><input id="c" type="password" name="code" autocomplete="off" required autofocus>
    <button type="submit">Make me admin</button>
  </form>` : `<p>Claiming admin is switched off. Set the <span class="mono">ADMIN_CLAIM_CODE</span> secret on the Worker to turn it on.</p>`}`, { user });

export const messagePage = (title, text, { user, status = 200, link = ["/", "Home"] } = {}) =>
  html(page(title, `<div class="kicker">sintfoap.xyz</div><h1>${esc(title)}</h1><p>${esc(text)}</p><p class="alt"><a href="${esc(link[0])}">${esc(link[1])}</a></p>`, { user }), { status });
