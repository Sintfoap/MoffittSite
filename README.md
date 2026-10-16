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
  cli.js           /login/cli: signing in from a terminal, approved in the browser
  auth.js          accounts, sessions, login throttling, two-factor
  crypto.js        password hashing (PBKDF2) and authenticator codes (TOTP)
  mail.js          sending email through Resend (address checks, reset links)
  pages.js         the sign-in, dashboard and account pages
  db.js            D1 tables (created on first use)
  tasks.js         todo storage, one list per account
  vendor/uqr.mjs   QR codes for two-factor setup (MIT)
apps/todo-esque/ the original Drift app (Python engine, terminal UI, CLI); `drift login` points it at your list here
tests/           node --no-warnings --test tests/*.test.mjs  (Drift's own: cd apps/todo-esque && python -m pytest tests)
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
- **Two-factor** uses authenticator-app codes (TOTP). It's optional for normal accounts and required for admins: an admin without it is sent to `/account` until it's set up. Setting it up asks for the password.
- **Recovery codes:** anyone can make 10 single-use codes on `/account` (password required); turning on two-factor makes a set too. They're stored hashed. A code stands in for the app code when signing in, and resets a forgotten password.
- **Email (optional):** people can add an address in account settings (password required). It only counts once they open the confirmation link sent to it, which works for 24 hours. It's used for nothing but password resets.
- **Forgot username or password** (`/login/forgot`), two ways. Either way the page tells you your username, signs out every other device and signs you in. People with neither ask an admin, who can still reset passwords from `/admin`.
  - *By email:* enter a confirmed address and every account using it gets an email with its username and a reset link that works once, for an hour. The page answers the same whether or not the address matched. One inbox gets at most 3 emails an hour, and one network address can ask for 10. Accounts with two-factor also need an app code or recovery code to finish.
  - *With a recovery code:* the code identifies its account, so no username is needed. Accounts with two-factor need a fresh app code as well.
- **Dashboard:** `/dashboard` is where people land after signing in. It shows a card for each app their areas give them (from `APPS` in `src/auth.js`) and links to `/account` for password, two-factor and session settings.
- **Areas** (`user_areas` table) decide who can use which part of the site. `protect(request, env, "<area>", inner)` in `src/account.js` lets only signed-in accounts with that area through. Pages redirect to `/login`; API calls get 401 or 403.
- **Terminal sign-in** (`/login/cli`): `python -m drift login` in `apps/todo-esque/` shows a short code; you open `/login/cli` in a browser where you're signed in (two-factor included) and approve it. The terminal never sees your password. What it gets is an ordinary session, so it expires the same way, counts in your sessions, and ends with "Sign out everywhere" or a password change. Codes work once, for 10 minutes, and one address can have 5 waiting. Approving always needs a button press on the site, so a link with someone else's code in it can't sign them in as you without you clicking Approve.
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
3. **Add it to the Worker** in the Cloudflare dashboard: **Workers & Pages → moffittsite → Settings → Variables and Secrets → Add**, type **Secret**, name `RESEND_API_KEY`, value the key.
4. The sender address is `MAIL_FROM` in `wrangler.jsonc` (`Sintfoap <no-reply@sintfoap.xyz>`). Change it there if you want a different one; it must be on the verified domain.

If adding an email fails, the account page shows Resend's reason, and the Worker's logs (**moffittsite → Observability**) have the full error. The usual one is that the domain isn't verified yet: until it is, Resend refuses every send from `sintfoap.xyz`.

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
