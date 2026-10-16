# sintfoap

sintfoap.xyz from the terminal: sign in, and see your dashboard as a terminal UI.

```bash
pipx install ./cli          # or: pip install ./cli    (Python 3.10+)
sintfoap                    # signs you in the first time, then opens your dashboard
```

| Command | |
|---|---|
| `sintfoap` | your dashboard (signs in first if needed) |
| `sintfoap login` | shows a code and opens the site; approve it there |
| `sintfoap dashboard --plain` | the dashboard as text, for scripts and pipes |
| `sintfoap chat [ROOM]` | the chat rooms from `/chat/`, in the terminal |
| `sintfoap whoami` | which account this terminal is signed in as |
| `sintfoap logout` | ends this terminal's session on the site |

Without installing: `cd cli && python -m sintfoap`.

With Nix (flakes), from the repo root or straight from GitHub:

```bash
nix run github:Sintfoap/MoffittSite          # run it without installing
nix profile install github:Sintfoap/MoffittSite
nix build                                    # ./result/bin/sintfoap, runs the tests too
nix develop                                  # a shell with Python, Textual and pytest
```

## Signing in

`sintfoap login` never asks for your password. It shows a short code and opens `sintfoap.xyz/login/cli`; you approve it there in a browser where you're signed in, so two-factor works the same as always. The terminal then gets an ordinary site session, kept in `~/.config/sintfoap/login.json` (only you can read it). It ends after 7 days unused or 30 days, or when you sign out everywhere or change your password, and then `sintfoap` asks you to sign in again.

`--site URL` or `SINTFOAP_SITE` signs in somewhere else (it must be https, or localhost for testing).

## The dashboard

The same cards as `/dashboard`, in the site's colours: one per app your account can use, and your account summary (two-factor, devices, recovery codes, email). It refreshes every 30 seconds.

| Key | |
|---|---|
| `tab` `↑↓←→` `hjkl` | move between cards |
| `enter` / click | open that card's page in your browser |
| `s` | account settings in your browser |
| `r` | refresh now |
| `o` | sign out this terminal |
| `q` | quit |

## Chat

`sintfoap chat` shows the same rooms as `/chat/` on the site: the list on the left, the open room on the right, and a line to type in. It opens the room you name, or your first room, and checks for new messages every few seconds, like the web page.

| | |
|---|---|
| `enter` | send what you typed (only in rooms you've joined) |
| `tab` / `esc` | move to the room list; `enter` on a room opens it |
| `/join` `/leave` | join or leave the open room |
| `/new NAME \| TOPIC` | make a room (`ctrl+n` starts this for you) |
| `/rename NAME` `/topic TEXT` | change the open room (its owner, or an admin) |
| `/delete` | delete your last message in the open room |
| `/older` | load older messages (`ctrl+u`) |
| `/help` `/quit` | |

Start a message with `//` to send one that begins with `/`.

## Files

```
sintfoap/site.py      signing in and out, reading the dashboard, the chat API (stdlib)
sintfoap/tui.py       the dashboard (Textual)
sintfoap/chat.py      chat (Textual)
sintfoap/__main__.py  the command
tests/                python -m pytest tests
```

The site's side is `src/cli.js`.
