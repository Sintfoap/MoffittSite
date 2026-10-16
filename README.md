# MoffittSite

Ryan Moffitt's portfolio, hosted on Cloudflare Workers.

```
public/          the website, served as static files
  index.html       homepage
  friends/         Friends & Associates page
  todo/            Drift (signed-in users only)
    app.js           the page: collections, views, item dialog
    lib.js           dates and quick-add parsing
    plugin-host.js   runs store plugins in the sandbox and cleans what they draw
    plugins/         Checklist, Events, List, Graph; one file each
  plugins/         the plugin store page (signed-in Drift users)
  sandbox/         the frame store plugins run in
src/             the Worker: runs only for the paths in run_worker_first
  worker.js        routing: sign-in pages, then /todo behind protect()
  account.js       /login /signup /logout /dashboard /account /admin, and protect()
  cli.js           /login/cli: signing in from a terminal, and the dashboard for it
  auth.js          accounts, sessions, login throttling, two-factor
  crypto.js        password hashing (PBKDF2) and authenticator codes (TOTP)
  mail.js          sending email through Resend (address checks, reset links)
  pages.js         the sign-in, dashboard and account pages
  db.js            D1 tables (created on first use)
  drift.js         Drift storage: collections and items per account
  store.js         the plugin store: drafts, review queue, approved plugins
  vendor/uqr.mjs   QR codes for two-factor setup (MIT)
cli/             the `sintfoap` command: sign in from a terminal, dashboard as a terminal UI
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

- **Accounts:** anyone can create one at `/signup` while `SIGNUPS` is `"open"`, up to `MAX_USERS`. New accounts get the `todo` area, so each person has their own todo list.
- **Passwords** are stored as salted PBKDF2-SHA256 hashes. `PASSWORD_ITERATIONS` sets the strength, at most 100,000, which is the Workers limit. On the Workers free plan (10 ms of CPU per request) a sign-in at 100,000 takes about 18 ms. If sign-ins fail with "exceeded resource limits", lower it, e.g. to `50000`. Existing hashes are upgraded or downgraded at each person's next sign-in.
- **Sessions** use a `__Host-sid` cookie: HttpOnly, Secure and SameSite=Lax. The database stores only its SHA-256. Sessions end after 30 days, or after 7 days unused. Changing your password signs out your other devices.
- **Throttling:** 5 wrong passwords lock that username for 1, then 2, 4 and 8, then 15 minutes. 30 failures from one address lock that address for 15 minutes. Each address can create 5 accounts per hour. Wrong usernames and wrong passwords give the same answer.
- **Two-factor** uses authenticator-app codes (TOTP). It's optional for normal accounts and required for admins: an admin without it is sent to `/account` until it's set up. Setting it up asks for the password.
- **Recovery codes:** anyone can make 10 single-use codes on `/account` (password required); turning on two-factor makes a set too. They're stored hashed. A code stands in for the app code when signing in, and resets a forgotten password.
- **Email (optional):** people can add an address in account settings (password required). It only counts once they open the confirmation link sent to it, which works for 24 hours. It's used for nothing but password resets.
- **Forgot username or password** (`/login/forgot`), two ways. Either way the page tells you your username, signs out every other device and signs you in. People with neither ask an admin, who can still reset passwords from `/admin`.
  - *By email:* enter a confirmed address and every account using it gets an email with its username and a reset link that works once, for an hour. The page answers the same whether or not the address matched. One inbox gets at most 3 emails an hour, and one network address can ask for 10. Accounts with two-factor also need an app code or recovery code to finish.
  - *With a recovery code:* the code identifies its account, so no username is needed. Accounts with two-factor need a fresh app code as well.
- **Dashboard:** `/dashboard` is where people land after signing in. It shows a card for each app their areas give them (from `APPS` in `src/auth.js`) and links to `/account` for password, two-factor and session settings.
- **Areas** (`user_areas` table) decide who can use which part of the site. `protect(request, env, "<area>", inner)` in `src/account.js` lets only signed-in accounts with that area through. Pages redirect to `/login`; API calls get 401 or 403.
- **Terminal sign-in** (`/login/cli`): `sintfoap login` (see `cli/`) shows a short code; you open `/login/cli` in a browser where you're signed in (two-factor included) and approve it. The terminal never sees your password. What it gets is an ordinary session, so it expires the same way, counts in your sessions, and ends with "Sign out everywhere" or a password change. Codes work once, for 10 minutes, and one address can have 5 waiting. Approving always needs a button press on the site, so a link with someone else's code in it can't sign them in as you without you clicking Approve. Once signed in, `sintfoap` shows the dashboard in the terminal, from `GET /login/cli/dashboard`.
- **Forms and API writes** sent from another website are refused, based on the `Origin` and `Sec-Fetch-Site` headers.

### Admin

`/admin` lists every account. From there an admin can:
- disable or enable an account (disabling signs it out),
- reset a password (shows a one-time temporary password the person must change),
- remove someone's two-factor,
- sign someone out everywhere,
- give or remove areas,
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

## Adding another protected area

1. Add `"/<area>"` and `"/<area>/*"` to `run_worker_first` in `wrangler.jsonc`.
2. Add the area's name to `AREAS` in `src/auth.js`. Add it to `DEFAULT_AREAS` too if new accounts should get it, and add an entry to `APPS` so it shows on the dashboard.
3. In `src/worker.js`, route those paths through `protect(request, env, "<area>", user => ...)`, the same way `/todo` is.
4. Give people the area from `/admin`.

## Drift

Drift lives at `/todo/`. Everything in it is an **item**: a title, notes, tags and the collection it's in. **Plugins** add their own metadata to items and their own ways of seeing them:

| Plugin | Adds to an item (`meta.<id>`) | View |
|---|---|---|
| Checklist (`checklist`) | `{done, done_at, priority}` | open and done items, tick boxes |
| Events (`event`) | `{start, end}`, as `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` | month calendar and agenda |
| List (`list`) | `{order, parent}` | an outline you reorder and nest |
| Graph (`graph`) | `{links, x, y}`: linked item ids, and where you pinned it | a network you drag, pan and zoom; "Link items" links or unlinks two items |

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
- **For now:** store plugins can't have `mount()` views (canvases and graphs) yet, only views drawn with `render()`.

The store page and its "Try it" are served with a strict Content-Security-Policy too, since they show other people's code.

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
