# MoffittSite

Ryan Moffitt's portfolio, hosted on Cloudflare Workers.

```
public/          the website, served as static files
  index.html       homepage
  llm.txt          guide for AI agents using Drift through the MCP server (/mcp)
  keys.js          the signed-in pages' g-chord shortcuts (g h, g d, g p, g s, g a, g o)
  rail.js          folds the side rail down to its icons and back (its button, or \), remembered per browser
  friends/         Friends & Associates page
  books/           Book club pick: public, no sign-in; anyone can vote (app.js talks to /books/api)
  todo/            Drift (signed-in users only)
    app.js           the page: collections, views, item dialog
    lib.js           dates and quick-add parsing
    plugin-host.js   runs store plugins in the sandbox and cleans what they draw
    plugins/         Checklist, Events, List, Graph, Locations, Weather; one file each
  plugins/         the plugin store page (signed-in Drift users)
  sandbox/         the frame store plugins run in
  chat/            chat rooms (signed-in Drift users); gifs.js is the GIF picker, emoji-picker.js the full reaction picker (emoji.js), e2ee.js encryption, carry.js its keys' copy for your other browsers
  m/               the phone app: its own screens for Home, Drift and Chat, on the same APIs as the pages above
  notifications/   turning push notifications on, and what they're for
  recipes/         Recipe box (signed-in users with it turned on); scale.js scales ingredient lines, shared with the Worker
  meals/           Meal plan: the week's dinners from Recipe box, around the Drift calendar
  sweep/           Sweep: Drift suggestions read out of your chat rooms, to accept or turn down
  sw.js            the service worker that shows push notifications
  site.webmanifest, icons/   so the site can be added to a phone's home screen
  favicon.svg, favicon.ico   the browser tab icon (the same emblem as icons/)
src/             the Worker: runs only for the paths in run_worker_first
  worker.js        routing: sign-in pages, then /todo behind protect()
  account.js       /login /signup /logout /dashboard /account /admin, and protect()
  apikeys.js       API keys AI agents sign in with: made and revoked on /account, stored hashed
  mcp.js           /mcp: the MCP server, so an agent can do what a person can in Drift
  mapimage.js      PNG pictures of a day's route on OpenStreetMap tiles, for the MCP's drift_get_map
  cli.js           /login/cli: signing in from a terminal, and its dashboard and settings
  auth.js          accounts, sessions, login throttling, two-factor
  crypto.js        password hashing (PBKDF2) and authenticator codes (TOTP)
  mail.js          sending email through Resend (address checks, reset links)
  pages.js         the sign-in, dashboard and account pages, and the side rail every signed-in page shows
  nav.js           the site's menu: one list, from APPS, that the rail and the terminal UI both use
  db.js            D1 tables (created on first use)
  drift.js         Drift storage: collections and items per account
  weather.js       the forecast for Drift's Weather plugin: 16 days at a spot, from Open-Meteo
  store.js         the plugin store: drafts, review queue, approved plugins
  chat.js          chat: rooms, members, messages
  gifs.js          chat's GIF picker: search, trending and categories from GIPHY (or KLIPY), and favorites
  push.js          sending Web Push: encryption (RFC 8291) and VAPID signing, with WebCrypto
  notify.js        notifications: settings, browsers, Chat's pushes and Drift's reminders
  recipes.js       Recipe box: recipes read from a link's schema.org data (Recipe Keeper's shared recipes too), and their ingredients sent to a Drift list
  meals.js         Meal plan: a week of dinners picked from Recipe box, quick ones on busy Drift nights, and the week's shopping sent to a Drift list
  sweep.js         Sweep: reads chosen chat rooms with Claude and suggests Drift events, tasks and list items
  books.js         the book club pick's list and votes (/books/api), and who voted for admins
  bridges.js       chat connections: other platforms' rooms in chat, with sealed credentials
  matrix.js        the Matrix provider for those
  vendor/uqr.mjs   QR codes for two-factor setup (MIT)
cli/             the `sintfoap` command: sign in from a terminal; dashboard, Drift, plugin store, chat, Recipe box, Meal plan, Sweep and settings as a terminal UI
apps/todo-esque/ the original Drift app (Python engine, terminal UI, CLI)
tests/           node --no-warnings --test tests/*.test.mjs  (the CLI's: cd cli && python -m pytest tests)
wrangler.jsonc   Worker configuration (name, static files, variables, database)
```

## Cloudflare settings

The site is a Cloudflare **Worker** with static assets, deployed by Workers Builds on every push.

| Setting | Value |
|---|---|
| Build command | *(empty)* |
| Deploy command | `npx wrangler deploy` |
| Root directory | *(empty)* |

`wrangler.jsonc` holds everything else. The `name` in it must match the Worker's name in the dashboard. Only the paths in `run_worker_first` (sign-in pages, `/dashboard`, `/account`, `/admin`, `/todo`) run any code; everything else is served straight from `public/`.

Settings in `wrangler.jsonc` replace dashboard settings on every deploy. Change variables and bindings there, not in the dashboard. Secrets added in the dashboard are kept, and so are dashboard Text variables that `wrangler.jsonc` doesn't name (`keep_vars`).

Branch builds run `npx wrangler preview`, which uses the `previews` section of `wrangler.jsonc` instead of the production settings. It must list every variable. Previews get no database, so signing in fails closed on preview URLs while the rest of the site previews normally.

## Accounts and sign-in

The site has its own login. There's no Cloudflare Access.

- **Accounts:** anyone can create one at `/signup` while `SIGNUPS` is `"open"`, up to `MAX_USERS`. New accounts get Drift (the `todo` area); every other app starts off until an admin turns it on.
- **Passwords** are stored as salted PBKDF2-SHA256 hashes. `PASSWORD_ITERATIONS` sets the strength, at most 100,000, which is the Workers limit. On the Workers free plan (10 ms of CPU per request) a sign-in at 100,000 takes about 18 ms. If sign-ins fail with "exceeded resource limits", lower it, e.g. to `50000`. Existing hashes are upgraded or downgraded at each person's next sign-in.
- **Sessions** use a `__Host-sid` cookie: HttpOnly, Secure and SameSite=Lax. The database stores only its SHA-256. Sessions end after 30 days, or after 7 days unused. Changing your password signs out your other devices.
- **Throttling:** 5 wrong passwords lock that username for 1, then 2, 4 and 8, then 15 minutes. 30 failures from one address lock that address for 15 minutes. Each address can create 5 accounts per hour. Wrong usernames and wrong passwords give the same answer.
- **Two-factor** uses authenticator-app codes (TOTP). It's optional for normal accounts and required for admins: an admin without it is sent to `/account` until it's set up. Setting it up asks for the password.
- **Recovery codes:** anyone can make 10 single-use codes on `/account` (password required); turning on two-factor makes a set too. They're stored hashed. A code stands in for the app code when signing in, and resets a forgotten password.
- **Email (optional):** people can add an address in account settings (password required). It only counts once they open the confirmation link sent to it, which works for 24 hours. It's used for nothing but password resets.
- **Forgot username or password** (`/login/forgot`), two ways. Either way the page tells you your username, signs out every other device and signs you in. People with neither ask an admin, who can still reset passwords from `/admin`.
  - *By email:* enter a confirmed address and every account using it gets an email with its username and a reset link that works once, for an hour. The page answers the same whether or not the address matched. One inbox gets at most 3 emails an hour, and one network address can ask for 10. Accounts with two-factor also need an app code or recovery code to finish.
  - *With a recovery code:* the code identifies its account, so no username is needed. Accounts with two-factor need a fresh app code as well.
- **Dashboard:** `/dashboard` is where people land after signing in. It shows what's due today and overdue in Drift (by the visitor's time zone, from Cloudflare), an account check (two-factor, recovery codes, email) and a card for each app their areas give them (from `APPS` in `src/auth.js`).
- **Look:** every signed-in page (dashboard, settings, admin, Drift, plugin store) uses the terminal dashboard's look: monospace type, square double-ruled panels, gold on green-black (or on paper in light mode, following the system), one shared side rail and a key bar along the bottom. `g` then a letter jumps between apps (`public/keys.js`; the rail shows each letter). The rail's **Collapse** button, or `\`, folds it down to its icons so apps get the room; the browser remembers it (`public/rail.js`). In the terminal, `\` hides and shows a page's own side panel (Drift's views, chat's rooms, Recipe box's shelf). The server pages' styles are in `src/pages.js`; Drift and the store carry the same colours in their own `<style>` blocks.
- **Menu:** the dashboard owns the side rail. `siteNav()` in `src/nav.js` builds it from `APPS` in `src/auth.js` and the account's areas; server pages render it directly, and the Worker puts it into Drift, the plugin store and chat where their HTML has `<!--site-rail-->`. A new app only needs an entry in `APPS` (with its `icon` and `g` `key`) to show up everywhere, the terminal UI included (it reads the same list as `nav` from `/login/cli/dashboard`).
- **Areas** (`user_areas` table) decide who can use which part of the site. Each app in `APPS` is its own area (Drift's is `todo`), so each has its own per-account toggle on `/admin`. `protect(request, env, "<area>", inner)` in `src/account.js` lets only signed-in accounts with that area through. Pages redirect to `/login`; API calls get 401 or 403.
- **Terminal sign-in** (`/login/cli`): `sintfoap login` (see `cli/`) shows a short code; you open `/login/cli` in a browser where you're signed in (two-factor included) and approve it. The terminal never sees your password. What it gets is an ordinary session, so it expires the same way, counts in your sessions, and ends with "Sign out everywhere" or a password change. Codes work once, for 10 minutes, and one address can have 5 waiting. Approving always needs a button press on the site, so a link with someone else's code in it can't sign them in as you without you clicking Approve. Once signed in, `sintfoap` shows the dashboard in the terminal, from `GET /login/cli/dashboard`. That gives the terminal the same things the web dashboard shows, including the Today items (`today`) and the date label (`date`), and Drift and the plugin store through the same APIs as their web pages. Its settings page uses `GET`/`POST /login/cli/account` (display name) and `POST /login/cli/account/sessions` (sign out everywhere else); everything on `/account` that needs the password stays on the website.
- **API keys and MCP** (`/mcp`): on `/account`, anyone with Drift can make API keys (password required; shown once; up to 10) to give an AI agent. The agent connects to `https://sintfoap.xyz/mcp` (MCP over HTTP) with `Authorization: Bearer <key>` and gets tools for everything a person can do in Drift: read state and the agenda, create, change and delete items and collections (one at a time or up to 50 at once), link items in Graph, look up places, set bases and plan routes, get a PNG picture of a day's Map (`drift_get_map`, drawn in the Worker on OpenStreetMap tiles by `src/mapimage.js`), share collections, and add store plugins. It calls the same functions as Drift's web API, so the same checks apply. Keys are stored as SHA-256 hashes, ignored by every other route (and `/mcp` ignores cookies), and stop working when revoked or when the account is disabled or loses Drift. Changing a password doesn't revoke them. `public/llm.txt` is the guide agents read.
- **Forms and API writes** sent from another website are refused, based on the `Origin` and `Sec-Fetch-Site` headers.

### Admin

`/admin` lists every account. From there an admin can:
- disable or enable an account (disabling signs it out),
- reset a password (shows a one-time temporary password the person must change),
- remove someone's two-factor,
- sign someone out everywhere,
- turn each app on or off for each account: there's a toggle per app in `APPS`, so a new app shows up there by itself, off for everyone (the terminal's admin page, `g a`, has the same toggles),
- delete an account and its tasks.

It also lists todo tasks whose owner isn't an account, such as lists from the old Access login, and can move them to an account.

### Becoming the first admin

1. **Add the claim secret.** In the dashboard, go to **Workers & Pages → moffittsite → Settings → Variables and Secrets → Add**. Choose type **Secret**, name it `ADMIN_CLAIM_CODE`, and give it a long random value. Secrets aren't in `wrangler.jsonc`, and deploys keep them.
2. **Create your account** at `/signup`.
3. **Claim admin** at `/admin/claim` with that code. This only works while no admin exists.
4. **Set up two-factor** on `/account`, which you'll be sent to. Save the recovery codes.
5. **Delete the secret.** It does nothing once an admin exists, so you can delete it.

### Turning on email

Email goes out through [Resend](https://resend.com) (free for up to 3,000 emails a month). Until it's set up, everything about email is hidden and recovery codes still work.

1. **Create a Resend account** and add the domain `sintfoap.xyz` under **Domains**. Resend shows a few DNS records; add them in Cloudflare under **sintfoap.xyz → DNS → Records** and wait for Resend to say the domain is verified.
2. **Create an API key** in Resend under **API Keys**, with "Sending access" for that domain.
3. **Add it to the Worker** in the Cloudflare dashboard: **Workers & Pages → moffittsite → Settings → Variables and Secrets → Add**, type **Secret**, name `RESEND_API_KEY`, value the key. Pick type **Secret**, not **Text**: secrets stay hidden and every deploy keeps them.
4. The sender address is `MAIL_FROM` in `wrangler.jsonc` (`Sintfoap <no-reply@sintfoap.xyz>`). Change it there if you want a different one; it must be on the verified domain.

If adding an email fails, the account page shows Resend's reason, and the Worker's logs (**moffittsite → Observability**) have the full error. The usual one is that the domain isn't verified yet: until it is, Resend refuses every send from `sintfoap.xyz`.

## Book club pick

`/books/` is a public page where the book club votes on its next book, apart from the rest of the site: no sign-in, no side rail, its own look. It lists the books in `BOOKS` (`src/books.js`) with a description and places to get each, and anyone can vote for one. To change the books, edit that list; keep a book's `id` the same, since votes are stored under it.

- **One vote per browser**, tied to a random id in a cookie (`__Host-bv`). It can be moved to another book or taken back. Clearing cookies or using another browser gives another vote; one network address can cast 10 new votes a day.
- **Who voted:** browsers can't tell a website the computer's name, so each vote keeps what the site can see: the name the voter typed (optional), their account if they're signed in, their IP address, browser and system (from the User-Agent; the terminal's includes the computer's name), Cloudflare's guess at their city, and when. Admins see this under **Book votes** on `/admin` and can remove a vote.
- **Terminal:** `sintfoap books` shows the same page and votes from the terminal, signed in or not; admins also see who voted there.
- It's public, so it isn't in `APPS` and has no per-account toggle on `/admin`. Only `/books/api` runs the Worker.

## Adding another app

1. Add `"/<path>"` and `"/<path>/*"` to `run_worker_first` in `wrangler.jsonc`.
2. Add an entry to `APPS` in `src/auth.js` with its own `area` (usually its id), `icon` and `g` `key`. That puts it on the dashboard, the side rail, the terminal's menu and the admin page's toggles. It's off for everyone, existing and new accounts alike; only apps marked `onForNew` are given to new accounts.
3. In `src/worker.js`, route those paths through `protect(request, env, areaOf("<id>"), user => ...)`, the same way `/chat` is.
4. Turn it on for people from `/admin`.

A feature inside an app that should have its own toggle, but no place in the menu (Chat connections, say), is an `APPS` entry with `parent` set to its app's id. `PLACES` in `src/auth.js` is the list without those.

The plugin store and chat used to come with Drift's area. The first time the Worker runs against a database, `SPLIT_FROM_TODO` in `src/db.js` gives them to everyone who had Drift (once; `area_splits` records it), so nobody lost access when they got their own toggles.

## Drift

Drift lives at `/todo/`. Everything in it is an **item**: a title, notes, tags and the collection it's in. **Plugins** add their own metadata to items and their own ways of seeing them:

| Plugin | Adds to an item (`meta.<id>`) | View |
|---|---|---|
| Checklist (`checklist`) | `{done, done_at, priority}` | open and done items, tick boxes |
| Events (`event`) | `{start, end}`, as `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` | month calendar; the picked day shown by the hour, with a "No set time" list for undated-time items; an agenda |
| List (`list`) | `{order, parent}` | an outline you reorder and nest |
| Graph (`graph`) | `{links, rel?, kind?, x, y}`: linked item ids, an optional type per link (`{id: "depends on"}`, which makes it point one way), an optional kind for the item, and where you pinned it | a network you drag, pan and zoom; "Link items" links or unlinks two items, as a plain link or a typed arrow; kinds colour the nodes, and the legend hides kinds and link types |
| Locations (`location`) | `{place, lat, lng}`: what the place is called and where it is. You search for it (the site looks it up), pin it on the map, or paste coordinates | a map of the chosen day's events that have a place, numbered and joined in the order they happen, with the distance from each to the one before; picking one in the list flies the map there, and the day's events with no place can be pinned. **Range** shows a stretch of days at once instead (see below) |
| Weather (`weather`) | `{outdoor}`: whether it happens outdoors. Adding Weather to an item marks it outdoors; so does tagging a new one `#outdoor` (or `#outdoors`, `#outside`) | **Forecast**: the next 16 days, each with its weather and what's on it. With Weather on, the Calendar's days show their weather too, and an outdoor item on a wet day gets a warning (see below) |

Each **collection** picks which plugins are on, and shows a tab for each one's view. One item can carry several plugins' metadata at once, so a dated checklist item is also on the calendar. **Today** and **Calendar** in the sidebar show events from every collection.

Quick-add: `Lunch #food +Home !2 ^fri @1pm ~ Ferry Building, San Francisco` (tag, collection, priority, date, time, and after `~`, the place).

### Locations and OpenRouteService

Locations finds places through [OpenRouteService](https://openrouteservice.org) (built on OpenStreetMap), from the Worker, so the key never reaches a browser (`src/places.js`). Set it as a secret: **`ORS_API_KEY`**, a free key from openrouteservice.org (Workers & Pages → moffittsite → Settings → Variables and Secrets → Add, type Secret; or `wrangler secret put ORS_API_KEY`). Routing uses the same key. With it:

- The item dialog's Place box searches as you type (`GET /todo/api/places?q=…&near=lat,lng`, favouring places near the collection's others), and picking a result saves it.
- A place typed and saved without picking (from quick-add, the terminal, the phone or an agent) is looked up then, and the best match is kept; one that can't be found is refused with a message. An unchanged place isn't looked up again.
- A pin or pasted coordinates (`37.7955, -122.3937`, or an OpenStreetMap, Google Maps or `geo:` link) get the name of the spot (`GET /todo/api/places?lat=…&lng=…`).

Without the key, search is off and typed places stay "not found yet", but pins and pasted coordinates still work. The map's tiles come from OpenStreetMap, and Leaflet (`public/todo/vendor/leaflet/`, BSD-2) draws it.

#### Range

The Map's **Day / Range** switch shows several days at once, to check that what you've planned for different days sits well together (for a trip, say, whether something on Tuesday is really nearer Thursday's plans). Pick a first and last day, any length up to 14 days; ‹ › slide the whole stretch by its own length, and Today moves it to start today. Each day's places are pins in that day's colour, numbered again from 1 in the order they happen, with a legend (click a day to hide or show it) and the places listed under each day. An event that runs over several days is on each of them, and pins at exactly the same spot fan out a little so none hides another. Events with no place, or not found yet, are listed under their day and can be pinned. Range draws no route lines and uses no bases; those stay in Day. Switching to Range starts a week from the day you were looking at, and switching back returns to that day. It's all in the page (`rangeDays`, `normRange`, `rangeStops` and `dayColor` in `public/todo/plugins/location.js`); the MCP's `drift_get_map` picture, the phone app and the terminal still show one day.

#### Bases and routes

Each day starts and ends at a **base**, kept on the collection as `bases: [{place, lat, lng, from, to}]`: a home base (no dates) for every day, plus ones for a single day or a stretch of days. A day uses the base that covers it most closely, so a one-night stay beats a week's hotel, which beats home. Anyone who can edit the collection can change its bases (the Map's side panel, `b` in the terminal, or `PATCH /todo/api/collections/<id>` with only `{bases}`).

**Route** on the Map plans the order to visit the day's places in (`GET /todo/api/route?collection=…&day=…&profile=…&option=…`, `src/routing.js`, rules in `public/todo/route.js`):

1. Events with a time stay in time order.
2. Items linked in the Graph plugin are visited one after the other: either way round for a plain link, in the link's direction for a typed one ("leads to"). When the times keep linked places apart, they keep their order but not their closeness.
3. Everything else is ordered by travel time. The five best orders are offered to cycle between (‹ ›), and a timed stop you'd likely reach late is flagged.

Travel times come from OpenRouteService's matrix (one call), and the chosen order's streets from its directions (one call), for driving, walking or cycling; answers are cached for a day. Without the key, times are estimated from straight-line distance and the route is drawn straight.

### Weather

The forecast comes from [Open-Meteo](https://open-meteo.com) (no key needed), from the Worker: `GET /todo/api/weather?lat=…&lng=…` gives the next 16 days there (`{lat, lng, near, days: [{day, code, hi, lo, rain, precip}]}`: a WMO weather code, °C, the chance of rain in percent and mm of it), rounded to about a kilometre and cached by Cloudflare for half an hour (`src/weather.js`). Without `lat`, it's near where the request came from (Cloudflare's guess), with `near: true`; when that's unknown too, `days` is empty.

An item's weather is for its place (Locations), else its collection's base for that day, else near you; a day on the Calendar uses the collection's base, else near you. A day is **wet** when rain is at least 50% likely, 2 mm or more is expected, or there are thunderstorms. Then an outdoor item that isn't ticked off gets a ☂ chip (on Today and in its collection too), the day's cell on the Calendar shows ☂ in red, and the day's view names the outdoor items it spoils. Temperatures are in °F in an American English browser (or terminal locale), °C otherwise. The rules are in `public/todo/plugins/weather.js`, and the terminal's copy in `cli/sintfoap/drift_rules.py`.

### Sharing

The owner of a collection can share it from its settings with anyone who has a Drift account, as **Can edit** (add, change and delete items) or **Can view** (read only). It shows up under "Shared with you" in their sidebar, and its dated items appear in their Today and Calendar. Items stay stored under the owner, whoever added them, so they count toward the owner's limit and go away if the owner deletes the collection. Only the owner can rename it, change its plugins, share it or delete it; people it's shared with can leave it. Items can't be moved between a shared collection and one with a different owner.

### Adding a plugin

Write `public/todo/plugins/<name>.js` (the comment in `plugins/index.js` lists what a plugin can define) and add it to `PLUGINS` there. A simple view returns HTML from `render(ctx)` and is redrawn on every change. An interactive one (a zoomable graph, a canvas) defines `mount(el, ctx)` to build itself once, `update(ctx)` for changes, and `unmount()`, so it keeps its own state. Its `clean()` runs in the Worker too, so the API checks its metadata with no other server change. New plugins start switched off in existing collections.

### API

All endpoints act only on the signed-in user's own data.

| Method | Path | Body |
|---|---|---|
| GET | `/todo/api/state` | → `{version, user, plugins, collections, items}` |
| GET | `/todo/api/version` | → `{version}`, which changes whenever any of your data does. The page checks it every 5 seconds and reloads only when it changes, so edits from other devices appear within a few seconds |
| POST | `/todo/api/items` | `{title, collection, notes, tags, meta}` |
| PATCH | `/todo/api/items/<id>` | any of those, or `deleted`. Each `meta.<plugin>` is replaced whole; `null` removes it |
| DELETE | `/todo/api/items/<id>` | |
| POST | `/todo/api/collections` | `{name, plugins, view, order}` |
| PATCH | `/todo/api/collections/<id>` | any of those, `bases`, or `deleted`. `{bases}` alone works for anyone who can edit it |
| GET | `/todo/api/route?collection=<id>&day=YYYY-MM-DD` | `&profile=driving-car\|foot-walking\|cycling-regular&option=n` → the day's route: `{base, options: [{order, duration, distance, late}], option, legs, path, estimated}` |
| DELETE | `/todo/api/collections/<id>` | hides its items too; you can't delete your last one |
| POST | `/todo/api/collections/<id>/shares` | `{username, role}`, role `edit` or `view`. Owner only; sending it again changes the role |
| DELETE | `/todo/api/collections/<id>/shares/<username>` | the owner removes someone, or you leave a collection shared with you |

### Tasks from the old todo list

The first time someone opens Drift, their old tasks (`todo_tasks`) move over: each project becomes a collection (no project goes to Inbox), done and priority become Checklist metadata, and a due date becomes an all-day event. Tasks an admin moves to an account later move over the same way.

`apps/todo-esque/` is the original standalone Drift (Python, terminal UI, sync folder). It isn't deployed and doesn't share data with the site.

## Plugin store

`/plugins/` is where people share Drift plugins. Anyone with the `todo` area can use it.

- **Writing:** "My plugins" has an editor in the browser. A new plugin starts from a small working example. Saving keeps a private draft.
- **Review:** "Submit for review" sends the draft to the queue. Admins see a Review tab with each submission's code, compared line by line with the version that's live. Approving puts it in the store; rejecting needs a note, which the author sees.
- **Versions:** edits after approval stay private until the next approval, so the store always serves code an admin has read. Deleting a plugin, or its author's account, takes it out of the store.
- **Trying a plugin:** "Try it" in the editor runs the code in the sandbox (below) against three sample items and shows its rows, item editor and view, plus any errors.
- **Adding to Drift:** "Add to Drift" on an approved plugin adds it to your Drift. Turn it on for a collection in that collection's settings. People you share the collection with get the plugin for it too.

### How store plugins are kept apart

Store plugins never run in Drift's page or in the Worker.

- **The sandbox:** they run in `/sandbox/`, a hidden frame loaded with `sandbox="allow-scripts"`, so it has no origin and can't use your session. Its Content-Security-Policy allows no network at all, so plugin code can't send your data anywhere. Each plugin gets its own worker inside it, and one that takes more than 2 seconds to answer is stopped until the page reloads.
- **What they can see:** a copy of the items on screen, as plain data.
- **What they can change:** only their own slice of an item's metadata, through Drift. They can't change titles, notes or tags, or other plugins' data.
- **What they can draw:** Drift cleans the HTML they return (`public/todo/plugin-host.js`). Scripts, styles, links, images, ids and event handlers are removed.
- **On the server:** Drift accepts metadata for approved store plugins as plain JSON, up to 8 KB per plugin per item.
- **Interactive views:** a `mount()` view draws on a canvas from inside the plugin's worker (below). It never gets the page's DOM, so it can't read the page or send anything anywhere.

The store page and its "Try it" are served with a strict Content-Security-Policy too, since they show other people's code.

### Interactive views in store plugins

A store plugin's view can return HTML from `render(ctx)`, or be interactive like Graph: `mount(surface, ctx)`, then `update(ctx)` on each change and `unmount()`. Instead of an element it gets a `surface`:

- `surface.canvas`: an `OffscreenCanvas` already sized for the screen (`surface.width` × `surface.height` CSS pixels, at `surface.dpr`). Drift shows it in the view.
- `surface.colors`: Drift's theme colours (`bg`, `surface`, `raise`, `line`, `ink`, `muted`, `accent` and so on).
- `surface.on(type, (event, ctx) => …)`: `pointerdown`, `pointermove`, `pointerup`, `pointerleave`, `click`, `dblclick`, `wheel`, `keydown`, `resize` and `theme`. Pointer events have `x` and `y` on the canvas; `wheel` has `dx` and `dy`; `keydown` has `key`.
- `surface.cursor = "grab"` (or `pointer`, `grabbing`, `move`, `crosshair`, `text`, `zoom-in`, `zoom-out`).

`ctx.open(id)` and `ctx.setMeta(id, pluginId, value)` work in `mount()` and in event handlers. Called later, from a timer, they're ignored. Pointer moves and wheel turns that pile up while a handler runs are merged, and a handler that takes over 2 seconds stops the plugin as before. Keys pressed on the focused canvas go to the plugin, except Escape and Tab. "Try it" shows the view against the sample items and says what it asked Drift to do.

| Method | Path | Body |
|---|---|---|
| GET | `/plugins/api/state` | |
| GET | `/plugins/api/store/<id>` | (the approved version, with code) |
| POST | `/plugins/api/mine` | `{id, name, description, code}` |
| PATCH | `/plugins/api/mine/<id>` | any of `{name, description, code}` |
| DELETE | `/plugins/api/mine/<id>` | |
| POST | `/plugins/api/mine/<id>/submit` | `{note}` |
| POST | `/plugins/api/mine/<id>/withdraw` | |
| GET | `/plugins/api/review` | admins only |
| POST | `/plugins/api/review/<id>/<version>` | admins only: `{decision: "approve" \| "reject", note}` |
| GET | `/todo/api/installs` | the store plugins you've added to Drift |
| POST | `/todo/api/installs/<id>` | add an approved plugin |
| DELETE | `/todo/api/installs/<id>` | remove it (collections using it keep their data) |

## Chat

`/chat/` is chat rooms for everyone with the `todo` area, the same people who can use Drift and the plugin store.

- **Rooms:** anyone can make a room (up to 20 each). Open rooms are listed for everyone and their names are unique. Whoever made a room can rename it, change its topic or delete it; admins can too, for rooms they can see.
- **Private rooms** are only for their members: to anyone else, admins included, they don't exist (every request about one is a 404). Any member can add people; the owner can take people out; anyone can leave, and a private room with nobody left in it is deleted.
- **Direct messages:** "Message someone" (`m`) opens the room between you and one other person, made the first time either of you asks. Its id comes from the two accounts, so there's only ever one. It's named for the other person and can't be renamed, left or deleted.
- **Joining:** anyone can open an open room and read it. Joining lets you post and puts the room under "Your rooms" with an unread count.
- **Search** (`f`) finds messages in the open room containing some text, newest first, from any time or the past month, 3, 6, 12 or 24 months; picking one scrolls back to it. In a room from Matrix it also asks Matrix's own search, so history that hasn't been brought in yet is found (marked *on Matrix*; picking one brings history in until it's there). An end-to-end encrypted room is searched in the browser holding its keys, which reads back through the room's history to the start of the range (20 pages at a time) and decrypts it there. In the terminal, `/search 6m TEXT` or `/search 1y TEXT` searches back that far.
- **Who's here:** each poll records that you have the room open. Others see "Here now: …" (anyone in the last 30 seconds) and "… is typing" (the page reports typing at most every 3 seconds, and it lasts 6). Members lists and DMs show who's had chat open in the last minute.
- **Messages:** text up to 2,000 characters, with web links clickable and a little Markdown: `**bold**`, `*italic*` (or `_italic_`), `~~struck~~`, `` `code` ``, code blocks between ```` ``` ```` lines, `> ` quotes and `[words](https://link)`. The body is kept as typed, so search and the terminal see the same text (`public/chat/format.js` renders it on the page; the terminal styles it the same way). You can edit and delete your own (an edited message says so); a room's owner and admins can delete anyone's. Ten messages per ten seconds per person, at most. On the page, `↑` in an empty message box edits your last message.
- **Mentions:** `@username` in a message mentions that person. It's highlighted for them, and the room shows `@` in their room list until they read it. Typing `@` offers the room's members to pick from.
- **Replies:** **Reply** on a message (`/reply [@name] text` in the terminal) answers it. The reply shows who and what it answers above it, and clicking that scrolls back to it; a deleted one says so.
- **Reactions:** members react to a message with one of 👍 ❤️ 😂 🎉 😮 😢 👀 🙏; each shows a count, and hovering shows who.
- **GIFs:** the **GIF** button by the message box (or `Ctrl+G`) opens a picker modelled on Discord's. Before you type it shows tiles for your **Favorites**, **Trending GIFs** and categories; typing searches as you go, in two columns that load more as you scroll. Clicking a GIF sends it (shift-click keeps the picker open), and the star on each one keeps it in your favorites; GIFs in the chat have a ★ too. Arrow keys move around the grid and Enter sends. In the terminal, `ctrl+g` or `/gif [text]` opens the same picker as a list, and `/star` stars the last GIF in the room. See [GIFs](#gifs).
- **Updates:** the page asks for new messages every 2.5 seconds while it's visible and refreshes the room list every 15. Every change in a room (a new, edited or deleted message, or a reaction) takes the room's next `seq` number, so asking for what changed since a number catches all of them. Rooms and messages are in D1 like everything else, so no extra Cloudflare setup is needed.
- **Deleting an account** removes its messages, reactions and memberships. Rooms it made stay, for admins to manage.

| Method | Path | Body |
|---|---|---|
| GET | `/chat/api/state` | (you, every room you can see, who's online, and the reactions on offer) |
| GET | `/chat/api/people` | (everyone else who can use chat) |
| POST | `/chat/api/dms` | `{username}`: your direct message room with them |
| POST | `/chat/api/rooms` | `{name, topic, private}` |
| PATCH | `/chat/api/rooms/<id>` | any of `{name, topic}` (owner or admin) |
| DELETE | `/chat/api/rooms/<id>` | (owner or admin) |
| POST | `/chat/api/rooms/<id>/join` | |
| POST | `/chat/api/rooms/<id>/leave` | |
| GET | `/chat/api/rooms/<id>/members` | |
| POST | `/chat/api/rooms/<id>/members` | `{username}`: add someone to a private room (members) |
| DELETE | `/chat/api/rooms/<id>/members/<username>` | take someone out of a private room (owner, or yourself) |
| GET | `/chat/api/rooms/<id>/search` | `?q=<text>[&months=<0–60>]` → `{messages, more, since, platform?, platform_error?}`; in a bridge room, results only on the platform have `id: null`, `ext_id` and `on_platform` |
| POST | `/chat/api/rooms/<id>/typing` | (members) |
| GET | `/chat/api/rooms/<id>/messages` | `?since=<seq>` for changes, `?before=<message id>` for older pages; also says who's `here` and `typing`, and in a bridge room how far people there have read (`reads: [{name, message}]`) |
| POST | `/chat/api/rooms/<id>/messages` | `{body, reply_to?}` (members), or `{encrypted, reply_to?}` in an encrypted bridge room: content the browser encrypted. `reply_to` is the message it answers, in the same room |
| PATCH | `/chat/api/rooms/<id>/messages/<message id>` | `{body}` (author), or `{encrypted}` as above, an `m.replace` edit of that message |
| DELETE | `/chat/api/rooms/<id>/messages/<message id>` | (author, room owner or admin) |
| POST | `/chat/api/rooms/<id>/messages/<message id>/reactions` | `{emoji, on}`: add (`true`) or take back (`false`) a reaction (members); in a bridge room any short emoji, and in an encrypted one adding also takes `{encrypted}` |
| GET | `/chat/api/gifs` | `?q=<text>&pos=<next>`: a GIF search, or what's trending without `q` → `{results, next}` |
| GET | `/chat/api/gifs/categories` | (the picker's category tiles) |
| GET | `/chat/api/gifs/favorites` | (your starred GIFs, newest first) |
| POST | `/chat/api/gifs/favorites` | `{gif: {url, preview, width, height, title}, on}`: star a GIF, or take the star off |
| GET | `/chat/api/connections` | (your connections to other platforms; needs Chat connections) |
| POST | `/chat/api/connections` | `{provider, ...its fields}`, e.g. `{provider: "matrix", homeserver, token}`: connect, and sync once |
| DELETE | `/chat/api/connections/<id>` | remove it and its rooms |
| POST | `/chat/api/connections/<id>/sync` | sync now, and try again if it had stopped working |
| POST | `/chat/api/connections/<id>/dm` | `{user, encrypted?}` → `{id}`: a direct message with someone there (their id, e.g. `@sam:matrix.org`) |
| POST | `/chat/api/connections/<id>/crypto/claim` | `{key, vault?}`: this browser holds the connection's encryption keys (only if no other does); `vault` is its browser key, kept sealed so the keys can follow you → `{device, kept, saved}` |
| POST | `/chat/api/connections/<id>/crypto/inbox` | `{key, ack}`: what syncs brought for the keys, after marking up to `ack` taken → `{items, counts}` |
| POST | `/chat/api/connections/<id>/crypto/save` | `{key, copy, ack}`: a copy of the keys (at most 8 MB), having taken the inbox up to `ack` → `{saved}` |
| POST | `/chat/api/connections/<id>/crypto/take` | `{key, force?}`: move the keys to this browser → `{device, vault, copy}`, or `{busy}` while another browser used them in the last minute |
| POST | `/chat/api/connections/<id>/crypto/request` | `{key, method, path, body}`: one of the key requests encryption needs, passed on to Matrix → `{response}` |

### GIFs

GIFs come from [GIPHY](https://developers.giphy.com) (`/v1/gifs/search`, `/trending`, `/categories`), or from [KLIPY](https://klipy.com), the service Discord moved to when Google shut down Tenor's API in June 2026, through KLIPY's Tenor-compatible API (`/v2/search`, `/v2/featured`, `/v2/categories`). Both are in `src/gifs.js`. The browser never talks to either API: the site asks on its behalf, so the key stays on the server, and the picker says which service it's using ("Powered by GIPHY").

- **Turning it on with GIPHY:** at developers.giphy.com, sign in, **Create an App**, choose **API** (not SDK), and copy its API key. Then **Workers & Pages → moffittsite → Settings → Variables and Secrets → Add**, type **Secret**, name `GIPHY_API_KEY`. A new GIPHY key is a beta key, limited to 100 requests an hour; GIPHY's dashboard has an **Upgrade to Production** request for more.
- **Or with KLIPY:** an API key from KLIPY's partner panel (partner.klipy.com → API Keys) as the secret `GIF_API_KEY`. `GIF_API_BASE` (a variable) points it at another service with the same API. If both keys are set, GIPHY is used.
- Without either key the GIF button is hidden and the terminal says GIFs aren't set up. `GIF_HOSTS` changes where GIFs may be shown from (default `klipy.com tenor.com giphy.com` and their subdomains).
- **Sending** a GIF posts an ordinary message whose whole text is the GIF's link, so it counts toward the message rate, can be deleted like any message, and reaches Matrix rooms and the terminal as a link. The chat page shows a message like that as the picture, but only for `https` links to `.gif` or `.webp` files on `GIF_HOSTS`. The page's CSP lets it load pictures from those hosts and nowhere else, and they're loaded without a referrer.
- **Favorites** are kept per account in D1 (up to 200), so the web page and the terminal share them. Deleting an account deletes them.
- Search results are rated PG-13 on GIPHY, and use KLIPY's `medium` content filter there. GIPHY's tracking parameters are dropped from the links that are sent.

### Connections to other platforms

Chat can also bring in your rooms from other chat platforms, so you read and answer them in the same place. **Matrix** is the first (Element and any other Matrix app use the same rooms); others plug in the same way. It's its own toggle on `/admin`, **Chat connections**, off for everyone until an admin turns it on. It has no place of its own in the menu: it's the **Connections** button (`k`) on the chat page, and `/connect` in the terminal.

- **Connecting Matrix:** your homeserver (`matrix.org`, or your own; `.well-known` is followed the way Element does) and either an access token (Element: *Settings → Help & About → Access token*) or your Matrix username and password. A password is used once, to sign in a new session called `sintfoap.xyz`, and is never stored; that session is signed out when you remove the connection. A token you paste is left alone when you remove it, since it's probably Element's own.
- **Rooms** you're in there show up under a heading for the platform, marked `~`. Only you see them, admins included. Messages from people there are shown with their names there; yours, sent from here or from Element, are yours. Unread counts, history and search work as in any room.
- **Sending, editing, deleting and reacting** go to Matrix (edits as Matrix edits, deletions and taken-back reactions as redactions, reactions as `m.reaction` annotations), and the same made there show up here. Reactions from Matrix can be any emoji; ones you add here come from the site's picker (`/react` in the terminal). In encrypted rooms a reaction is encrypted by the browser like a message, so it's added from the web page; what it's on and its emoji stay outside the encryption, as Matrix has it, so everyone sees them. Renaming rooms and adding people stay on the platform for now.
- **Invites, leaving and new conversations:** an invite on Matrix shows in the room list, marked *invite*, with **Accept** and **Decline** in the room (`/accept` and `/decline` in the terminal). **Leave** in a Matrix room leaves it there too. The **+** by a Matrix section's heading starts a direct message with someone by their Matrix ID (`/dm @sam:matrix.org [N]` in the terminal, through connection N). It's made the way Element makes one (invite-only, listed under People there, and end-to-end encrypted if the connection can hold keys, which you can turn off), or it's the one you already have with them.
- **Replies, formatting, typing and read receipts** go both ways too. A reply is a Matrix reply (`m.in_reply_to`), and one from Element shows what it answers, as long as that message is here. Formatting goes out as Matrix HTML (`formatted_body`) made from the Markdown above, and HTML coming in becomes that Markdown; anything else in it (colours, tables, images) is dropped to its text. While you type, Matrix shows you typing, and people typing there show here. Opening a room tells Matrix you've read up to its newest message, and "Seen by" under a message shows who there has read up to it. In encrypted rooms the formatting is encrypted with the words, and what a reply answers stays outside the encryption, as Matrix has it.
- **Pictures:** a picture sent on Matrix (a GIF from Element, say) shows as the picture. The site fetches it from the homeserver with the connection's sign-in (`GET /chat/api/rooms/<id>/media?mxc=…`, Matrix's authenticated media API or the older one), and serves only GIF, PNG, JPEG and WebP as pictures; anything else is data, never a page. A GIF from the picker goes to Matrix as a picture too: the site fetches it from GIPHY or KLIPY, uploads it to the homeserver and sends an image message, as Element would (if that fails it goes as its link). In **encrypted rooms** the browser does this itself: it gets the GIF's bytes through the site (`/chat/api/gifs/file`), encrypts them as Matrix encrypted attachments are (AES-CTR, with the key in the encrypted message), uploads the ciphertext (`POST /chat/api/rooms/<id>/media`) and sends the image message encrypted; pictures that arrive there are fetched as ciphertext and decrypted in the browser. The terminal shows pictures from Matrix as `[image] name`.
- **End-to-end encrypted rooms** (Element's default for direct messages) work on the chat page, with the keys made and used in your browser, and following you to any browser you sign in to. Open one and choose **Turn on encryption here**: the browser makes keys for the connection's session with Matrix's own crypto library (the one Element uses, vendored in `public/chat/vendor/matrix-crypto`), and from then on decrypts what comes in and encrypts what you send or edit before the site sees it. The site only passes things along: encrypted messages as they came, the to-device messages each sync brings (other people's devices sharing room keys), and the key requests the browser makes (`public/chat/e2ee.js`, `cryptoOp` in `src/bridges.js`). Some limits:
  - It needs a connection made with your **username and password**, so the site has a session of its own to hold keys. A pasted access token belongs to another app's session, whose keys are in that app, so its encrypted rooms stay read-only.
  - **The keys follow you.** One browser holds a connection's keys at a time. After they change, it sends the site a copy of the crypto library's store (`public/chat/carry.js`), still locked with that browser's own key, and the site keeps that key sealed with `CHAT_BRIDGE_KEY` and bound to your account (`crypto/save`, `chat_crypto_copies`). Opening an encrypted room in another of your browsers takes the keys there (`crypto/take`): it gets the latest copy, the key that opens it, and whatever syncs brought since, and the browser that had them lets go of its copy the next time it asks. If that one was in use in the last minute, the room asks first (**Bring them here**), so two open browsers don't pass them back and forth. Browsers that held keys before this send their first copy the next time chat is opened there. The trade-off: with both the database and `CHAT_BRIDGE_KEY`, the site's owner could open the keys, as they could the connection's sign-in; without the secret, the database alone gives nothing away.
  - **Verify with Security Key** (in the room, once encryption is on) does what Element's option of the same name does: your Security Key or Security Phrase opens your account's secret storage, here in the browser (it's never sent to the site). The site's session is then signed with your cross-signing key, so Element and other apps show it as verified, and it takes your key backup's key: messages it was never given keys for, such as ones from before it was connected, are unlocked from the backup, and keys for new ones are backed up too. This needs Secure Backup set up on the account (Element: *Settings → Security & Privacy*).
  - **Verify with another device** does it without the key: Element (or any app signed in to the account) is asked to verify this session, both show the same emoji, and once you confirm they match on both sides the session is verified and takes the key backup's key from the other one. A request started from Element shows here too, with Accept. Both of these happen in the browser, since that's where the site's keys are, so the terminal shows encrypted rooms but verifies on the web page.
  - The **terminal** shows encrypted messages as "Encrypted message" and sends to those rooms from the web page only, since the keys are only ever opened in a browser. `/connections` says where each connection's keys are.
- **Syncing** happens while chat is open: the room list and the open room each ask the platform what changed (at most every 2 seconds per connection, with Matrix's `/sync` and no waiting). Nothing runs in the background, so when you come back after a long time a busy room may show only its latest messages. A token that stops working marks the connection with the reason; **Sync now** tries again.
- **Older history:** connecting brings in each room's latest 20 messages. Scrolling back past the oldest one here (**Show older messages**, or `/older` in the terminal) brings in the page before it from Matrix (`/messages`), with edits made since, reactions and replies, until the room's start. Those messages sort before everything already here and aren't counted as unread. In encrypted rooms they decrypt with keys from your key backup, once the session is verified.
- **Encrypted rooms open readable:** what the browser has decrypted is kept in IndexedDB, sealed with AES-GCM under a key made from the connection's browser key, so opening a room shows its messages straight away instead of decrypting them all again. New ones are decrypted before they're shown.
- **Credentials** (the access token, never the password) are stored with your account, so a connection made once works wherever you sign in (the web page and the terminal alike). They're encrypted with AES-GCM before they're stored, under a key from the `CHAT_BRIDGE_KEY` secret and bound to their account, so the database alone doesn't give them away. Without the secret, nothing can be connected. To set it: **Workers & Pages → moffittsite → Settings → Variables and Secrets → Add**, type **Secret**, name `CHAT_BRIDGE_KEY`, value a long random string (e.g. from `openssl rand -base64 32`). Changing it later means everyone reconnects.
- **Deleting an account** deletes its connections and their rooms. (Sessions the site signed in on Matrix stay signed in there; end them from Element's session list.)

**Adding a platform:** write `src/<platform>.js` with the shape described at the top of `src/bridges.js` (`fields`, `connect`, `sync`, `send`, `edit`, `remove`, `react`, `disconnect`, optionally `typing` and `receipt`, and for encryption `canEncrypt`, `device`, `sendEncrypted`, `cryptoRequest`) and add it to `PROVIDERS` there. The connect form on the web page and in the terminal is built from its `fields`, so nothing else changes.

## Notifications

`/notifications/` is where people opt into push notifications for Chat and Drift. It's an app in `APPS` like the others, so it has its own toggle on `/admin` and starts off for everyone. Nothing is ever pushed to a browser that hasn't been turned on from that page.

- **Turning them on:** "Turn on here" asks the browser for permission and registers `/sw.js`, then sends its push subscription to the site. Each browser or phone is turned on separately and listed under "Where they go", where any of them can be removed. Up to 10 per account. If someone else turns notifications on in the same browser, it moves to their account.
- **Chat** pushes a direct message, an `@mention` of you, and (off by default) every message in rooms you've joined. Nobody is pushed about a room they have open, or about their own messages. Private rooms and DMs only ever reach their members. Needs the Chat app too.
- **Chat connections** (Matrix): a message in one of your connected rooms that your notification settings on Matrix say is worth one (the same ones Element's phone app follows). While you have Notifications and Chat connections, the cron registers a *pusher* on your Matrix account pointing at `<SITE_URL>/_matrix/push/v1/notify`, so your homeserver tells the site the moment such a message arrives; the site syncs that connection and pushes it. A busy homeserver (matrix.org) can call before its syncs have the message, so then the site reads that one message from the homeserver directly, as Element's phone app does, and if even that can't find it yet, the next sync that brings it in pushes it. The pusher's key names the connection and is signed with `CHAT_BRIDGE_KEY`, so nothing else can pose as your homeserver. If a homeserver won't take a pusher, the cron syncs the connection every five minutes and pushes what's new instead, one notification per room. Encrypted messages only say who sent them, since their keys are in your browser. Turning the setting off, losing access or removing the connection takes the pusher off again.
- **Drift** reminds you before each timed item starts (15 minutes by default; when it starts, 5, 10, 30 minutes, an hour or a day before) and at 8am on the day of an all-day item, in the time zone of the browser you turned them on in. Items in collections shared with you remind you too. Done and deleted items don't. The reminders come from a cron trigger every five minutes (`triggers` in `wrangler.jsonc`, `scheduled()` in `src/worker.js`), and each is sent once (`push_sent`). Needs the Drift app too.
- **Sending:** the Worker encrypts each message for its browser and signs a VAPID token itself (`src/push.js`, WebCrypto only), then posts it to the browser's push service: Google, Mozilla, Apple or Microsoft. Subscriptions for any other host are refused. A browser whose push service says it's gone is forgotten, and so is one refused five times in a row.
- **iPhone and iPad:** Safari only allows push for sites added to the home screen (Share → Add to Home Screen). The page says so there; once it's opened from the home screen it works like anywhere else.
- **Terminal:** `sintfoap notifications` (`g n`) has the same settings and list of browsers, and sends a test. A terminal can't receive pushes itself.

### Turning on push

Push stays off, and the page says so, until the site has a VAPID key pair.

1. **Make the keys** on any computer with Node: `npx web-push generate-vapid-keys`. It prints a public key and a private key.
2. **Add them to the Worker** in the Cloudflare dashboard: **Workers & Pages → moffittsite → Settings → Variables and Secrets → Add**, type **Secret**, once as `VAPID_PUBLIC_KEY` and once as `VAPID_PRIVATE_KEY`.
3. **Turn Notifications on** for people from `/admin`.

`SITE_URL` in `wrangler.jsonc` is the site's own address, which Matrix pushers call back. `PUSH_CONTACT` is the address push services can reach the site's owner at (a `https:` or `mailto:` URL). Changing the keys later means everyone turns notifications on again. Preview builds have no database, so push can only be tried on the real site.

| Method | Path | Body |
|---|---|---|
| GET | `/notifications/api/state` | → `{configured, public_key, prefs, devices, apps, leads}` |
| PATCH | `/notifications/api/prefs` | any of `{chat_dms, chat_mentions, chat_rooms, chat_bridges, drift_events, drift_lead, tz}` |
| POST | `/notifications/api/devices` | the browser's `PushSubscription.toJSON()`, plus `{label, tz}` |
| DELETE | `/notifications/api/devices/<id>` | |
| POST | `/notifications/api/test` | pushes a test to all your browsers → also `{sent, failed}` |

## Meal plan

`/meals/` plans the week's dinners (Monday to Sunday) from your Recipe box, around your Drift calendar. It's an app in `APPS` with its own toggle on `/admin`, off for everyone; it reads the recipes you have in Recipe box, and it needs Drift for the calendar and the shopping list.

- **Busy nights:** a night is busy when an open Drift item that day has a time in the evening (it overlaps 4–9 pm; one with no end is taken to last an hour), or the day has three or more timed things. All-day items show but don't make a night busy.
- **Filling the week** picks a recipe for each empty night. Busy nights go first and get a quick recipe (30 minutes or less, from the recipe's Time); with none, the quickest there is. No recipe twice in a week while there are others, and last week's dinners only when nothing else is left. **Shuffle** picks again for every night that isn't locked.
- **Each night:** pick a recipe yourself (that locks it, so filling and shuffling leave it alone), change its servings, lock or unlock it, or mark it **Out** (nothing to cook or buy). A busy night with a slow recipe is flagged.
- **Shopping:** every planned recipe's ingredients, scaled to that night's servings, with the same line from two recipes listed once. Untick what you have, and the rest go to your Drift Shopping list (made the first time) or any list you can edit, each noting which dinners it's for.
- **Terminal:** `sintfoap meals` (`g m`).

| Request | |
|---|---|
| `GET /meals/api/week?start=<day>` | the week holding that day (this week without it): its nights, what's on in Drift, your recipes and the shopping |
| `PUT /meals/api/week/<monday>/<day>` | `{recipe?, servings?, out?, locked?}` → the week |
| `POST /meals/api/week/<monday>/fill` | `{redo?}`: recipes for the empty nights, or every unlocked one → the week |
| `POST /meals/api/week/<monday>/shop` | `{lines?, list?}`: the week's shopping onto a Drift list → `{list, added, shopped}` |

## Sweep

`/sweep/` reads the chat rooms you pick and suggests Drift items from them: events with a date, tasks someone took on, and things for a list ("we need eggs", "watch Severance"). Nothing goes into Drift until you accept it. It's an app in `APPS` with its own toggle on `/admin`, off for everyone; accepting needs Drift too.

- **Your own key:** Sweep calls Claude with each person's own Anthropic API key, so nobody's sweeps go on anyone else's bill. You add yours under "Your Anthropic key" on `/sweep/` (or `k` in the terminal). The site checks it with Anthropic, then keeps it sealed with the `CHAT_BRIDGE_KEY` secret (the same as Chat connections' credentials, so that secret has to be set) and never sends it back; the page shows only its last four characters. Without a key nothing is sent anywhere. It uses `claude-opus-5-5` (with server-side fallbacks, so a busy model falls back instead of failing); set the `SWEEP_MODEL` variable to use another.
- **Rooms:** any room you're a member of, Chat connections' rooms included if you have that app. Tick a room and choose how far back to read it (the last day up to 30 days). Each sweep reads only what's new since the last one, up to 300 messages, oldest first; if there's more, it says so and the next sweep carries on.
- **Encrypted rooms** can't be read yet, since their keys are only in your browser. The page lists them greyed out. Reading them from the browser, then from a Matrix session of Sweep's own, comes next.
- **What Claude sees:** the room's name, who said what and when ("Me" for you), today's date in your time zone, the names of your Drift collections, and the suggestions you've accepted and turned down before. The conversation is marked as data, not instructions. Suggestions you already have in Drift, or that were already made from that room, are dropped.
- **Accepting:** an event goes in with its date and time, a task as a checklist item, a list item into the list it names (a new list is made for it if you don't have one). Edit first to change the title, kind, date or collection. The item's notes say which room and who it came from.
- **Turning down** takes an optional reason. Your last 30 decisions, edits and reasons are shown to Claude on the next sweep, so it learns what you want.
- **Limits:** a sweep every 20 seconds per account, 20 rooms at a time.
- **Terminal:** `sintfoap sweep` (`g w`).

| Request | |
|---|---|
| `GET /sweep/api/state` | your rooms, waiting suggestions, recent decisions and collections |
| `PUT /sweep/api/rooms/<id>` | `{on, days}`: whether to read a room, and how far back |
| `PUT /sweep/api/key` | `{key}`: check your Anthropic API key and keep it, in place of any before; `DELETE` removes it |
| `POST /sweep/api/sweep` | `{tz, rooms?}`: read what's new and suggest |
| `POST /sweep/api/suggestions/<id>/accept` | `{title?, kind?, start?, end?, collection?}`: add it to Drift |
| `POST /sweep/api/suggestions/<id>/reject` | `{reason?}` |

## Phone app

`/m/` is the site made for a phone rather than shrunk from the desktop pages: Home (Drift's today and chat rooms with something new), Drift (Today, a week-at-a-time Calendar, each collection's Checklist, List and Graph, quick-add at the bottom, a sheet per item), Chat (rooms, one room full screen, reactions, replies and edits from a sheet), and More (display name, signing out other devices, and links to what's still only on the full site). It reads and writes the same APIs as the web pages and the terminal, so all three stay in sync, and it shows only the apps the admin page has turned on for you.

It's plain static files in `public/m/`, no build step. `drift-logic.js` and `chat-logic.js` hold its rules without any DOM, reusing Drift's own `public/todo/lib.js` and plugins, and are what `tests/phone-app.test.mjs` checks.

- **The Android app** is a small APK in `android/` that opens `/m/` full screen in Chrome (a Trusted Web Activity), so it updates with every deploy like the site does. The APK itself rarely changes (its icon, name or permissions). When it does, push a tag `app-v<N>`, with N one higher than last time. `.github/workflows/android.yml` then builds it as version N and attaches it to a GitHub Release as `sintfoap.apk`. The app opens `/m/?app=<N>`, and Home and More offer the download once `/app/latest.json` (src/phone.js) names a newer N. `/app` is the download page, with a QR code to scan from a computer, and `sintfoap app` prints the same QR code in a terminal.
- **Install it** from Chrome on Android: open `sintfoap.xyz/m/`, then ⋮ → **Install app**. It has its own manifest (`/m/app.webmanifest`, scoped to `/m/`), so it installs as its own app next to the full site. New versions arrive with every deploy.
- **Not yet in it:** end-to-end encrypted Matrix rooms (read and sent on the full chat page, where their keys are), the plugin store, notification settings and admin. More links to each.

### Setting up the Android app's signing key (once)

The APK must always be signed with the same key, or phones refuse to update it, so the key lives in the repository's secrets.

1. **Make the key** on any computer with Java: `keytool -genkeypair -v -keystore sintfoap.jks -alias sintfoap -keyalg RSA -keysize 2048 -validity 10000`. Use the same password for the store and the key. Keep `sintfoap.jks` and the password somewhere safe; losing them means uninstalling and reinstalling the app once.
2. **Add three repository secrets** under **Settings → Secrets and variables → Actions**: `ANDROID_KEYSTORE_B64` (the output of `base64 -w0 sintfoap.jks`), `ANDROID_KEYSTORE_PASSWORD`, and `ANDROID_KEY_ALIAS` (`sintfoap`).
3. **Tell the site the key's fingerprint.** `keytool -list -v -keystore sintfoap.jks` prints a `SHA256:` line. Add it to the Worker as a **Text** variable named `ANDROID_CERT_SHA256`. It's public, so it doesn't need to be a secret. That turns on `/.well-known/assetlinks.json`, which is what lets the app open without a browser bar. Each release's build summary prints the fingerprint too, to check against.
4. **Release:** `git tag app-v1 && git push origin app-v1`. The APK appears at `/app` a few minutes after the build finishes.
