# Drift

A to-do app where the data doesn't live inside any app. Your tasks are a folder of plain-text logs; the terminal UI, the web UI, the CLI and anything else you write are just windows onto that folder.

```
                    ┌──────────── your vault (any synced folder) ────────────┐
                    │  log/laptop-3fa9c1.jsonl   ← only the laptop writes    │
                    │  log/phone-77d2e0.jsonl    ← only the phone writes     │
                    │  log/desktop-a01b22.jsonl  ← only the desktop writes   │
                    └───────────────▲───────────────────────▲────────────────┘
          Syncthing / Dropbox /     │                       │
          iCloud / git / rsync      │                       │
                        ┌───────────┴──────────┐   ┌────────┴─────────┐
                        │   drift/core.py      │   │   drift/core.py  │   ← same engine everywhere
                        │   Store              │   │   Store          │
                        └──┬────────┬───────┬──┘   └──────────────────┘
                           │        │       │
                     drift tui   drift CLI  drift web ── HTTP + live events ──► browser (desktop, phone)
```

## How it works

**One writer per file.** Each device appends to its own `log/<device-id>.jsonl`. No two devices ever write the same file, so a dumb file-sync tool can never produce a conflict copy or corrupt Anything. ThE device id lives in `~/.local/state/drift/node-id`, outside the vault, so it never syncs.

**Every change is one line.** An operation sets a single field on a single task:

```json
{"id":"t_4d9d8424a7","f":"done","v":true,"t":"0001792085032445-0000-laptop-3fa9c1"}
```

**Hybrid logical clocks order everything.** The `t` stamp is wall-time milliseconds, a counter, and the device id. When a device reads someone else's op it advances its own clock past it, so even with skewed device clocks, causally later edits always sort later. Stamps compare as plain strings.

**Merging is just "newest stamp wins, per field".** State is a fold over every op in every log. That's a last-writer-wins register per field, which is a CRDT: any two devices that have seen the same ops compute exactly the same tasks, no matter which order the logs arrived in. If you rename a task on your phone while marking it done on your laptop, both edits survive because they touch different fields. If both of you rename it, the later rename wins, deterministically, everywhere.

**Deletes are just a field.** `deleted: true` is an op like any other, which is why undo is free.

**Partial syncs are safe.** The reader only consumes complete lines and remembers a byte offset per log, so a half-transferred file is picked up correctly on the next pass.

### How each frontend stays current

| Frontend | Reads | Writes | Sees other devices' changes |
|---|---|---|---|
| Terminal UI | `Store` in-process | its own log | polls the vault folder every ¾ s and redraws |
| Web UI | `GET /api/tasks` | `POST`/`PATCH`/`DELETE` → server's log | server polls the vault, pushes `change` over Server-Sent Events, page re-fetches |
| CLI | `Store` | its own log | each run reads fresh |
| Your script | `from drift.core import Store` | its own log | `store.subscribe(fn)` + `store.watch()` |

Run the TUI and the web server on the same machine and they update each other live, because they're two readers of the same folder.

## Install

Python 3.10+. The core, CLI and web server use only the standard library; the terminal UI needs Textual.

```bash
pip install textual            # only for the TUI
cd drift
python -m drift                # opens the terminal UI on ~/Drift
```

Optional shell alias: `alias drift="python -m drift"` (run from this folder, or add it to `PYTHONPATH`).

Pick a vault with `--vault ~/Sync/Drift` or `export DRIFT_VAULT=~/Sync/Drift`.

## Using it from anywhere

1. **Put the vault in a synced folder.** Syncthing is the most decentralized option (peer to peer, no cloud). Dropbox, iCloud Drive, OneDrive or a git repo all work, since nothing ever writes the same file twice.
2. **Terminal anywhere you have a shell**, including over SSH: `python -m drift`.
3. **Browser on your LAN:** `python -m drift web --host 0.0.0.0 --token choose-a-secret`, then open `http://<machine>:7878/?token=choose-a-secret` on your phone. Add it to the home screen.
4. **Browser from outside your network:** put that server behind Tailscale (simplest), or a reverse proxy with HTTPS.
5. **The web page is portable.** `web/index.html` works opened from anywhere; use *Sync settings* to point it at any running `drift web`. With no server it keeps a local list in the browser using the same op-log model.

## Quick-add syntax

Works in the TUI, the web UI and the CLI.

| Token | Meaning | Examples |
|---|---|---|
| `#word` | tag | `#errands` |
| `+word` | project | `+home` |
| `!1` `!2` `!3` or `!` `!!` `!!!` | priority | `!!!` |
| `^when` | due date | `^today` `^tom` `^fri` `^+3d` `^2w` `^11/02` `^2026-11-02` `^week` |

`Call Sam about flights #family +travel !2 ^fri`

## Keys

**Terminal UI**

| Key | Action |
|---|---|
| `a` | add a task |
| `space` | done / not done |
| `e` or `enter` | edit (`ctrl+s` saves, `esc` cancels) |
| `0`–`3` | set priority |
| `t` | move to today |
| `d` / `u` | delete / undo |
| `/` | filter |
| `tab` | switch between sidebar and list |
| `j` `k` | move |
| `q` | quit |

**Web UI:** `n` add, `j`/`k` move, `x` done, `e` open, `0`–`3` priority, `t` today, `⌫` delete, `/` filter, `g` then `t u i a d` to switch view, `?` for the list.

## CLI

```bash
python -m drift add "Pay rent +home ^1st !3"
python -m drift ls                 # open tasks; --all, --project home, --tag errands
python -m drift done 4d9d84        # any unique id prefix
python -m drift rm 4d9d84
python -m drift info               # vault path, this device's id, devices seen
```

## Your list on sintfoap.xyz

The CLI and terminal UI can use your todo list on the website instead of a local vault.

```bash
python -m drift login              # shows a code and opens the site; approve it there
python -m drift                    # the terminal UI, now on your site list
python -m drift ls                 # add, ls, done, rm too
python -m drift whoami
python -m drift --local ls         # the local vault, while still signed in
python -m drift logout             # ends that session on the site, back to the vault
```

You approve the sign-in in a browser where you're already signed in, two-factor included, so the terminal never asks for your password. It keeps the session in `~/.config/drift/site.json` (only you can read it). It's a normal site session: it ends after 7 days unused or 30 days, or when you sign out everywhere or change your password, and then `drift` tells you to run `drift login` again.

The terminal UI re-fetches every 5 seconds, so changes made on the website show up on their own. If the site can't be reached, the status bar turns red and saving shows an error instead of quitting. `drift web` always serves the local vault. `--site URL` or `DRIFT_SITE` signs in somewhere else (it must be https).

## HTTP API

| Method | Path | Body | |
|---|---|---|---|
| GET | `/api/tasks` | | tasks, projects, tags, stats |
| POST | `/api/tasks` | `{"text": "quick-add text"}` or explicit fields | create |
| PATCH | `/api/tasks/<id>` | any of `title notes done priority due project tags` | update |
| DELETE | `/api/tasks/<id>` | | soft delete |
| GET | `/api/events` | | Server-Sent Events; `change` on every vault change |

Auth: `?token=…` or `Authorization: Bearer …` when started with `--token` (or `DRIFT_TOKEN`).

## Files

```
drift/core.py      the engine: HLC, op log, merge, quick-add parser   (stdlib)
drift/server.py    REST + SSE bridge for browsers                     (stdlib)
drift/tui.py       terminal UI                                        (Textual)
drift/site.py      drift login/logout, and RemoteStore for your list on the site (stdlib)
drift/__main__.py  CLI entry point
web/index.html     web UI, single file, no build step
tests/             convergence and site-login tests, seed data, TUI smoke test
```

## Where to take it next

- **Compaction:** logs only grow. A `drift compact` that writes a snapshot plus a fresh log per device would keep startup fast after years of use.
- **Recurring tasks:** a `repeat` field (`weekly`, `every 3d`) that spawns the next task when one is completed.
- **Ordering by hand:** the `order` field exists; drag-to-reorder in the web UI would write fractional orders between neighbours.
- **Encryption:** encrypt each op line with a shared key so the vault can sit in an untrusted cloud.
- **Direct browser sync:** compile the same merge logic into the page and sync over WebRTC or a dumb relay, so a phone needs no server at all.
