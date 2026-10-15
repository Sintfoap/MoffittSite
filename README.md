# MoffittSite

Ryan Moffitt's portfolio, hosted on Cloudflare Pages.

```
public/          the website, published as-is (no build step)
  index.html       homepage
  friends/         Friends & Associates page
  todo/            Drift todo app (signed-in users only)
functions/       server code that Cloudflare runs in front of the site
  _lib/access.js   checks the Cloudflare Access sign-in on protected paths
  _lib/tasks.js    todo storage in Cloudflare D1, one list per user
  todo/            /todo/* — sign-in check (_middleware.js) and /todo/api/tasks
apps/todo-esque/ the original Drift app (Python engine, terminal UI, CLI)
tests/           node --no-warnings --test tests/*.test.mjs
```

## Cloudflare Pages settings

| Setting | Value |
|---|---|
| Framework preset | None |
| Build command | *(empty)* |
| Build output directory | `public` |

Cloudflare picks up `functions/` automatically. Only requests under `/todo/` run any code; everything else is served as static files.

## How protected areas work

There are two locks, and both must pass:

1. **Cloudflare Access** sits in front of `/todo/` and only lets in the email addresses on its policy. People sign in with a one-time code sent to their email. No passwords are stored anywhere.
2. **`functions/todo/_middleware.js`** checks, on every request, that Access signed the request for the todo application. If Access is switched off, misconfigured, or bypassed (for example through the `*.pages.dev` address), `/todo/` returns an error instead of opening up.

Each signed-in email address gets its own todo list. To give someone a list, add their email to the Access policy. Nothing else needs to change.

## One-time setup for /todo/

1. **Create the database.** In the Cloudflare dashboard, go to **Storage & Databases → D1 → Create** and name it, e.g. `moffittsite-todo`. The table is created automatically on first use.
2. **Bind it to the site.** Go to **Workers & Pages → your project → Settings → Bindings → Add → D1 database**. Set the variable name to `TODO_DB` and pick the database.
3. **Turn on Zero Trust.** Open **Zero Trust** from the dashboard sidebar. The first time, it asks for a team name, which becomes `<team>.cloudflareaccess.com`. The Free plan covers up to 50 users.
4. **Create the Access application.** Go to **Zero Trust → Access → Applications → Add an application → Self-hosted**:
   - Add a public hostname: your domain, with path `todo`. If you also use `www.`, add that as a second hostname with the same path.
   - Add a policy: action **Allow**, include **Emails**, then list the people who should have a todo list.
   - Save. On the application's overview, copy the **Application Audience (AUD) Tag**.
5. **Tell the site about it.** Go to **Workers & Pages → your project → Settings → Variables and Secrets** and add:
   - `ACCESS_TEAM_DOMAIN` = `<team>.cloudflareaccess.com`
   - `ACCESS_AUD_TODO` = the AUD tag. You can comma-separate several tags, e.g. one for a preview-deployment app.
6. **Redeploy** (or push), then visit `/todo/`.

## Adding another protected area later

1. Create a folder `functions/<area>/` with a `_middleware.js` like the todo one, using a new variable name:
   ```js
   import { requireAccess } from "../_lib/access.js";
   export const onRequest = requireAccess("ACCESS_AUD_<AREA>");
   ```
2. Create an Access application for path `<area>` with its own policy, and set `ACCESS_AUD_<AREA>` to its AUD tag.

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
