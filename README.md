# MoffittSite

Ryan Moffitt's portfolio, hosted on Cloudflare Workers.

```
public/          the website, served as static files
  index.html       homepage
  keys.js          the signed-in pages' g-chord shortcuts (g h, g d, g p, g s, g a, g o)
  friends/         Friends & Associates page
  todo/            Drift (signed-in users only)
    app.js           the page: collections, views, item dialog
    lib.js           dates and quick-add parsing
    plugin-host.js   runs store plugins in the sandbox and cleans what they draw
    plugins/         Checklist, Events, List, Graph; one file each
  plugins/         the plugin store page (signed-in Drift users)
  sandbox/         the frame store plugins run in
  chat/            chat rooms (signed-in Drift users)
  notifications/   turning push notifications on, and what they're for
  sw.js            the service worker that shows push notifications
  site.webmanifest, icons/   so the site can be added to a phone's home screen
src/             the Worker: runs only for the paths in run_worker_first
  worker.js        routing: sign-in pages, then /todo behind protect()
  account.js       /login /signup /logout /dashboard /account /admin, and protect()
  cli.js           /login/cli: signing in from a terminal, and its dashboard and settings
  auth.js          accounts, sessions, login throttling, two-factor
  crypto.js        password hashing (PBKDF2) and authenticator codes (TOTP)
  mail.js          sending email through Resend (address checks, reset links)
  pages.js         the sign-in, dashboard and account pages, and the side rail every signed-in page shows
  nav.js           the site's menu: one list, from APPS, that the rail and the terminal UI both use
  db.js            D1 tables (created on first use)
  drift.js         Drift storage: collections and items per account
  store.js         the plugin store: drafts, review queue, approved plugins
  chat.js          chat: rooms, members, messages
  push.js          sending Web Push: encryption (RFC 8291) and VAPID signing, with WebCrypto
  notify.js        notifications: settings, browsers, Chat's pushes and Drift's reminders
  bridges.js       chat connections: other platforms' rooms in chat, with sealed credentials
  matrix.js        the Matrix provider for those
  vendor/uqr.mjs   QR codes for two-factor setup (MIT)
cli/             the `sintfoap` command: sign in from a terminal; dashboard, Drift, plugin store and settings as a terminal UI
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
- **Look:** every signed-in page (dashboard, settings, admin, Drift, plugin store) uses the terminal dashboard's look: monospace type, square double-ruled panels, gold on green-black (or on paper in light mode, following the system), one shared side rail and a key bar along the bottom. `g` then a letter jumps between apps (`public/keys.js`; the rail shows each letter). The server pages' styles are in `src/pages.js`; Drift and the store carry the same colours in their own `<style>` blocks.
- **Menu:** the dashboard owns the side rail. `siteNav()` in `src/nav.js` builds it from `APPS` in `src/auth.js` and the account's areas; server pages render it directly, and the Worker puts it into Drift, the plugin store and chat where their HTML has `<!--site-rail-->`. A new app only needs an entry in `APPS` (with its `icon` and `g` `key`) to show up everywhere, the terminal UI included (it reads the same list as `nav` from `/login/cli/dashboard`).
- **Areas** (`user_areas` table) decide who can use which part of the site. Each app in `APPS` is its own area (Drift's is `todo`), so each has its own per-account toggle on `/admin`. `protect(request, env, "<area>", inner)` in `src/account.js` lets only signed-in accounts with that area through. Pages redirect to `/login`; API calls get 401 or 403.
- **Terminal sign-in** (`/login/cli`): `sintfoap login` (see `cli/`) shows a short code; you open `/login/cli` in a browser where you're signed in (two-factor included) and approve it. The terminal never sees your password. What it gets is an ordinary session, so it expires the same way, counts in your sessions, and ends with "Sign out everywhere" or a password change. Codes work once, for 10 minutes, and one address can have 5 waiting. Approving always needs a button press on the site, so a link with someone else's code in it can't sign them in as you without you clicking Approve. Once signed in, `sintfoap` shows the dashboard in the terminal, from `GET /login/cli/dashboard`. That gives the terminal the same things the web dashboard shows, including the Today items (`today`) and the date label (`date`), and Drift and the plugin store through the same APIs as their web pages. Its settings page uses `GET`/`POST /login/cli/account` (display name) and `POST /login/cli/account/sessions` (sign out everywhere else); everything on `/account` that needs the password stays on the website.
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

Each **collection** picks which plugins are on, and shows a tab for each one's view. One item can carry several plugins' metadata at once, so a dated checklist item is also on the calendar. **Today** and **Calendar** in the sidebar show events from every collection.

Quick-add: `Dentist #health +Home !2 ^fri @3pm` (tag, collection, priority, date, time).

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
| PATCH | `/todo/api/collections/<id>` | any of those, or `deleted` |
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
- **Search** (`f`) finds messages in the open room containing some text, newest first; picking one scrolls back to it.
- **Who's here:** each poll records that you have the room open. Others see "Here now: …" (anyone in the last 30 seconds) and "… is typing" (the page reports typing at most every 3 seconds, and it lasts 6). Members lists and DMs show who's had chat open in the last minute.
- **Messages:** plain text up to 2,000 characters, shown with web links clickable and nothing else formatted. You can edit and delete your own (an edited message says so); a room's owner and admins can delete anyone's. Ten messages per ten seconds per person, at most. On the page, `↑` in an empty message box edits your last message.
- **Mentions:** `@username` in a message mentions that person. It's highlighted for them, and the room shows `@` in their room list until they read it. Typing `@` offers the room's members to pick from.
- **Reactions:** members react to a message with one of 👍 ❤️ 😂 🎉 😮 😢 👀 🙏; each shows a count, and hovering shows who.
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
| GET | `/chat/api/rooms/<id>/search` | `?q=<text>` |
| POST | `/chat/api/rooms/<id>/typing` | (members) |
| GET | `/chat/api/rooms/<id>/messages` | `?since=<seq>` for changes, `?before=<message id>` for older pages; also says who's `here` and `typing` |
| POST | `/chat/api/rooms/<id>/messages` | `{body}` (members), or `{encrypted}` in an encrypted bridge room: content the browser encrypted |
| PATCH | `/chat/api/rooms/<id>/messages/<message id>` | `{body}` (author), or `{encrypted}` as above, an `m.replace` edit of that message |
| DELETE | `/chat/api/rooms/<id>/messages/<message id>` | (author, room owner or admin) |
| POST | `/chat/api/rooms/<id>/messages/<message id>/reactions` | `{emoji, on}`: add (`true`) or take back (`false`) a reaction (members) |
| GET | `/chat/api/connections` | (your connections to other platforms; needs Chat connections) |
| POST | `/chat/api/connections` | `{provider, ...its fields}`, e.g. `{provider: "matrix", homeserver, token}`: connect, and sync once |
| DELETE | `/chat/api/connections/<id>` | remove it and its rooms |
| POST | `/chat/api/connections/<id>/sync` | sync now, and try again if it had stopped working |
| POST | `/chat/api/connections/<id>/crypto/claim` | `{key}`: this browser holds the connection's encryption keys (only if no other does) → `{device}` |
| POST | `/chat/api/connections/<id>/crypto/inbox` | `{key, ack}`: what syncs brought for the keys, after taking back up to `ack` → `{items, counts}` |
| POST | `/chat/api/connections/<id>/crypto/request` | `{key, method, path, body}`: one of the key requests encryption needs, passed on to Matrix → `{response}` |

### Connections to other platforms

Chat can also bring in your rooms from other chat platforms, so you read and answer them in the same place. **Matrix** is the first (Element and any other Matrix app use the same rooms); others plug in the same way. It's its own toggle on `/admin`, **Chat connections**, off for everyone until an admin turns it on. It has no place of its own in the menu: it's the **Connections** button (`k`) on the chat page, and `/connect` in the terminal.

- **Connecting Matrix:** your homeserver (`matrix.org`, or your own; `.well-known` is followed the way Element does) and either an access token (Element: *Settings → Help & About → Access token*) or your Matrix username and password. A password is used once, to sign in a new session called `sintfoap.xyz`, and is never stored; that session is signed out when you remove the connection. A token you paste is left alone when you remove it, since it's probably Element's own.
- **Rooms** you're in there show up under a heading for the platform, marked `~`. Only you see them, admins included. Messages from people there are shown with their names there; yours, sent from here or from Element, are yours. Unread counts, history and search work as in any room.
- **Sending, editing and deleting** your messages go to Matrix (edits as Matrix edits, deletions as redactions), and edits and deletions made there show up here. Reactions, renaming, leaving and adding people stay on the platform for now.
- **End-to-end encrypted rooms** (Element's default for direct messages) work on the chat page, with the keys kept in your browser and never on the site. Open one and choose **Turn on encryption here**: the browser makes keys for the connection's session with Matrix's own crypto library (the one Element uses, vendored in `public/chat/vendor/matrix-crypto`), and from then on decrypts what comes in and encrypts what you send or edit before the site sees it. The site only passes things along: encrypted messages as they came, the to-device messages each sync brings (other people's devices sharing room keys), and the key requests the browser makes (`public/chat/e2ee.js`, `cryptoOp` in `src/bridges.js`). Some limits:
  - It needs a connection made with your **username and password**, so the site has a session of its own to hold keys. A pasted access token belongs to another app's session, whose keys are in that app, so its encrypted rooms stay read-only.
  - **One browser** holds a connection's keys: the one that turned encryption on. Others say where the keys are. To move them, remove the connection and connect it again. Clearing the browser's site data loses them the same way.
  - **Verify with Security Key** (in the room, once encryption is on) does what Element's option of the same name does: your Security Key or Security Phrase opens your account's secret storage, here in the browser (it's never sent to the site). The site's session is then signed with your cross-signing key, so Element and other apps show it as verified, and it takes your key backup's key: messages it was never given keys for, such as ones from before it was connected, are unlocked from the backup, and keys for new ones are backed up too. This needs Secure Backup set up on the account (Element: *Settings → Security & Privacy*).
  - Only messages the site has brought in can be shown: the latest 20 per room when you connected, and everything after.
  - The **terminal** shows encrypted messages as "Encrypted message" and sends to those rooms from the web page only, since the keys are in the browser.
- **Syncing** happens while chat is open: the room list and the open room each ask the platform what changed (at most every 2 seconds per connection, with Matrix's `/sync` and no waiting). Nothing runs in the background, so when you come back after a long time a busy room may show only its latest messages. A token that stops working marks the connection with the reason; **Sync now** tries again.
- **Credentials** (the access token, never the password) are encrypted with AES-GCM before they're stored, under a key from the `CHAT_BRIDGE_KEY` secret and bound to their account, so the database alone doesn't give them away. Without the secret, nothing can be connected. To set it: **Workers & Pages → moffittsite → Settings → Variables and Secrets → Add**, type **Secret**, name `CHAT_BRIDGE_KEY`, value a long random string (e.g. from `openssl rand -base64 32`). Changing it later means everyone reconnects.
- **Deleting an account** deletes its connections and their rooms. (Sessions the site signed in on Matrix stay signed in there; end them from Element's session list.)

**Adding a platform:** write `src/<platform>.js` with the shape described at the top of `src/bridges.js` (`fields`, `connect`, `sync`, `send`, `edit`, `remove`, `disconnect`, and for encryption `canEncrypt`, `device`, `sendEncrypted`, `cryptoRequest`) and add it to `PROVIDERS` there. The connect form on the web page and in the terminal is built from its `fields`, so nothing else changes.

## Notifications

`/notifications/` is where people opt into push notifications for Chat and Drift. It's an app in `APPS` like the others, so it has its own toggle on `/admin` and starts off for everyone. Nothing is ever pushed to a browser that hasn't been turned on from that page.

- **Turning them on:** "Turn on here" asks the browser for permission and registers `/sw.js`, then sends its push subscription to the site. Each browser or phone is turned on separately and listed under "Where they go", where any of them can be removed. Up to 10 per account. If someone else turns notifications on in the same browser, it moves to their account.
- **Chat** pushes a direct message, an `@mention` of you, and (off by default) every message in rooms you've joined. Nobody is pushed about a room they have open, or about their own messages. Private rooms and DMs only ever reach their members. Needs the Chat app too.
- **Drift** reminds you before each timed item starts (15 minutes by default; when it starts, 5, 10, 30 minutes, an hour or a day before) and at 8am on the day of an all-day item, in the time zone of the browser you turned them on in. Items in collections shared with you remind you too. Done and deleted items don't. The reminders come from a cron trigger every five minutes (`triggers` in `wrangler.jsonc`, `scheduled()` in `src/worker.js`), and each is sent once (`push_sent`). Needs the Drift app too.
- **Sending:** the Worker encrypts each message for its browser and signs a VAPID token itself (`src/push.js`, WebCrypto only), then posts it to the browser's push service: Google, Mozilla, Apple or Microsoft. Subscriptions for any other host are refused. A browser whose push service says it's gone is forgotten, and so is one refused five times in a row.
- **iPhone and iPad:** Safari only allows push for sites added to the home screen (Share → Add to Home Screen). The page says so there; once it's opened from the home screen it works like anywhere else.
- **Terminal:** `sintfoap notifications` (`g n`) has the same settings and list of browsers, and sends a test. A terminal can't receive pushes itself.

### Turning on push

Push stays off, and the page says so, until the site has a VAPID key pair.

1. **Make the keys** on any computer with Node: `npx web-push generate-vapid-keys`. It prints a public key and a private key.
2. **Add them to the Worker** in the Cloudflare dashboard: **Workers & Pages → moffittsite → Settings → Variables and Secrets → Add**, type **Secret**, once as `VAPID_PUBLIC_KEY` and once as `VAPID_PRIVATE_KEY`.
3. **Turn Notifications on** for people from `/admin`.

`PUSH_CONTACT` in `wrangler.jsonc` is the address push services can reach the site's owner at (a `https:` or `mailto:` URL). Changing the keys later means everyone turns notifications on again. Preview builds have no database, so push can only be tried on the real site.

| Method | Path | Body |
|---|---|---|
| GET | `/notifications/api/state` | → `{configured, public_key, prefs, devices, apps, leads}` |
| PATCH | `/notifications/api/prefs` | any of `{chat_dms, chat_mentions, chat_rooms, drift_events, drift_lead, tz}` |
| POST | `/notifications/api/devices` | the browser's `PushSubscription.toJSON()`, plus `{label, tz}` |
| DELETE | `/notifications/api/devices/<id>` | |
| POST | `/notifications/api/test` | pushes a test to all your browsers → also `{sent, failed}` |
