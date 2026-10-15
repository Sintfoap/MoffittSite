# MoffittSite

Ryan Moffitt's portfolio, hosted on Cloudflare Workers.

```
public/          the website, served as static files
  index.html       homepage
  friends/         Friends & Associates page
  todo/            Drift todo app (signed-in users only)
src/             the Worker: only runs for /todo and /todo/*
  worker.js        routing: sign-in check, then the todo API or page
  access.js        checks the Cloudflare Access sign-in
  tasks.js         todo storage in Cloudflare D1, one list per user
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

`wrangler.jsonc` holds everything else. The `name` in it must match the Worker's name in the dashboard. Requests outside `/todo` never run any code; Cloudflare serves them straight from `public/`.

Settings in `wrangler.jsonc` replace dashboard settings on every deploy. Change variables and bindings there, not in the dashboard.

Branch builds run `npx wrangler preview`, which uses the `previews` section of `wrangler.jsonc` instead of the production settings. It must list every variable. Its Access values are left empty on purpose, so `/todo` refuses everyone on preview URLs while the rest of the site previews normally.

## How protected areas work

There are two locks, and both must pass:

1. **Cloudflare Access** sits in front of `/todo/` and only lets in the email addresses on its policy. People sign in with a one-time code sent to their email. No passwords are stored anywhere.
2. **`src/worker.js`** checks, on every request under `/todo`, that Access signed the request for the todo application. If Access is switched off, misconfigured, or bypassed (for example through the `*.workers.dev` address), `/todo/` returns an error instead of opening up.

Each signed-in email address gets its own todo list. To give someone a list, add their email to the Access policy. Nothing else needs to change.

## One-time setup for /todo/

None of these values are secret. They identify things in your account but grant no access on their own, so they live in `wrangler.jsonc`.

1. **Create the database.** In the Cloudflare dashboard, go to **Storage & Databases → D1 → Create** and name it `moffittsite-todo`. Copy its **Database ID**. The table is created automatically on first use.
2. **Turn on Zero Trust.** Open **Zero Trust** from the dashboard sidebar. The first time, it asks for a team name, which becomes `<team>.cloudflareaccess.com`. The Free plan covers up to 50 users.
3. **Create the Access application.** Go to **Zero Trust → Access → Applications → Add an application → Self-hosted**:
   - Add a public hostname: your domain, with path `todo`. If you also use `www.`, add that as a second hostname with the same path.
   - Add a policy: action **Allow**, include **Emails**, then list the people who should have a todo list.
   - Save. On the application's overview, copy the **Application Audience (AUD) Tag**.
4. **Fill in `wrangler.jsonc`:**
   - `ACCESS_TEAM_DOMAIN` = `<team>.cloudflareaccess.com`
   - `ACCESS_AUD_TODO` = the AUD tag
   - Uncomment `d1_databases` and paste the Database ID.
5. **Push.** Workers Builds deploys it. Then visit `/todo/`.

## Adding another protected area later

1. Add `"/<area>"` and `"/<area>/*"` to `run_worker_first` in `wrangler.jsonc`.
2. In `src/worker.js`, route those paths through `protect(request, env, "ACCESS_AUD_<AREA>", ...)`, the same way `/todo` is.
3. Create an Access application for path `<area>` with its own policy, and add `ACCESS_AUD_<AREA>` to `vars` with its AUD tag.

To protect a sub-path more tightly (e.g. `/todo/admin`), add a second Access application for that longer path. Access applies the most specific match.

## Todo API

All endpoints act only on the signed-in user's own tasks.

| Method | Path | Body |
|---|---|---|
| GET | `/todo/api/tasks` | |
| POST | `/todo/api/tasks` | `{title, notes, done, priority, due, project, tags, order}` |
| PATCH | `/todo/api/tasks/<id>` | any of the fields above, or `deleted` |
| DELETE | `/todo/api/tasks/<id>` | |

Quick-add text (`#tag +project !2 ^fri`) is parsed by the client, so dates follow the user's own time zone.
