# MoffittSite

Ryan Moffitt's portfolio, hosted on Cloudflare Workers.

```
public/          the website, served as static files
  index.html       homepage
  friends/         Friends & Associates page
  todo/            Drift todo app (signed-in users only)
src/             the Worker: runs only for the paths in run_worker_first
  worker.js        routing: sign-in pages, then /todo behind protect()
  account.js       /login /signup /logout /dashboard /account /admin, and protect()
  auth.js          accounts, sessions, login throttling, two-factor
  crypto.js        password hashing (PBKDF2) and authenticator codes (TOTP)
  pages.js         the sign-in, dashboard and account pages
  db.js            D1 tables (created on first use)
  tasks.js         todo storage, one list per account
  vendor/uqr.mjs   QR codes for two-factor setup (MIT)
apps/todo-esque/ the original Drift app (Python engine, terminal UI, CLI)
tests/           node --no-warnings --test tests/*.test.mjs
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

Settings in `wrangler.jsonc` replace dashboard settings on every deploy. Change variables and bindings there, not in the dashboard.

Branch builds run `npx wrangler preview`, which uses the `previews` section of `wrangler.jsonc` instead of the production settings. It must list every variable. Previews get no database, so signing in fails closed on preview URLs while the rest of the site previews normally.

## Accounts and sign-in

The site has its own login. There's no Cloudflare Access.

- **Accounts:** anyone can create one at `/signup` while `SIGNUPS` is `"open"`, up to `MAX_USERS`. New accounts get the `todo` area, so each person has their own todo list.
- **Passwords** are stored as salted PBKDF2-SHA256 hashes. `PASSWORD_ITERATIONS` sets the strength, at most 100,000, which is the Workers limit. On the Workers free plan (10 ms of CPU per request) a sign-in at 100,000 takes about 18 ms. If sign-ins fail with "exceeded resource limits", lower it, e.g. to `50000`. Existing hashes are upgraded or downgraded at each person's next sign-in.
- **Sessions** use a `__Host-sid` cookie: HttpOnly, Secure and SameSite=Lax. The database stores only its SHA-256. Sessions end after 30 days, or after 7 days unused. Changing your password signs out your other devices.
- **Throttling:** 5 wrong passwords lock that username for 1, then 2, 4 and 8, then 15 minutes. 30 failures from one address lock that address for 15 minutes. Each address can create 5 accounts per hour. Wrong usernames and wrong passwords give the same answer.
- **Two-factor** uses authenticator-app codes (TOTP) plus 10 single-use recovery codes, stored hashed. It's optional for normal accounts and required for admins: an admin without it is sent to `/account` until it's set up.
- **Dashboard:** `/dashboard` is where people land after signing in. It shows a card for each app their areas give them (from `APPS` in `src/auth.js`) and links to `/account` for password, two-factor and session settings.
- **Areas** (`user_areas` table) decide who can use which part of the site. `protect(request, env, "<area>", inner)` in `src/account.js` lets only signed-in accounts with that area through. Pages redirect to `/login`; API calls get 401 or 403.
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

## Adding another protected area

1. Add `"/<area>"` and `"/<area>/*"` to `run_worker_first` in `wrangler.jsonc`.
2. Add the area's name to `AREAS` in `src/auth.js`. Add it to `DEFAULT_AREAS` too if new accounts should get it, and add an entry to `APPS` so it shows on the dashboard.
3. In `src/worker.js`, route those paths through `protect(request, env, "<area>", user => ...)`, the same way `/todo` is.
4. Give people the area from `/admin`.

## Todo API

All endpoints act only on the signed-in user's own tasks.

| Method | Path | Body |
|---|---|---|
| GET | `/todo/api/tasks` | |
| POST | `/todo/api/tasks` | `{title, notes, done, priority, due, project, tags, order}` |
| PATCH | `/todo/api/tasks/<id>` | any of the fields above, or `deleted` |
| DELETE | `/todo/api/tasks/<id>` | |

Quick-add text (`#tag +project !2 ^fri`) is parsed by the client, so dates follow the user's own time zone.
