# sintfoap

sintfoap.xyz from the terminal: sign in, then use your dashboard, Drift, the plugin store and your account settings as a terminal UI.

```bash
pipx install ./cli          # or: pip install ./cli    (Python 3.10+)
sintfoap                    # signs you in the first time, then opens your dashboard
```

| Command | |
|---|---|
| `sintfoap` | your dashboard (signs in first if needed) |
| `sintfoap drift` | Drift |
| `sintfoap store` | the plugin store |
| `sintfoap settings` | account settings |
| `sintfoap chat [ROOM]` | chat rooms, opening ROOM if you name one |
| `sintfoap notifications` | what's pushed to your browsers and phone, and where |
| `sintfoap recipes` | Recipe box: your recipes, scaled, and sent to a Drift shopping list |
| `sintfoap admin` | which apps each account can use (admins) |
| `sintfoap app` | the Android app: a QR code to scan with your phone, and the download link |
| `sintfoap books [--plain]` | the book club pick: read about the books and vote; no sign-in needed |
| `sintfoap login` | shows a code and opens the site; approve it there |
| `sintfoap dashboard --plain` | the dashboard as text, for scripts and pipes |
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

The same panels as `/dashboard`, in the site's colours: Today (overdue Drift items in red, then what's due today), your account with its checks (two-factor, recovery codes, email), and a card per app your account can use. It refreshes every 30 seconds. Drift, the plugin store, chat, Recipe box, notifications, account settings and Admin open here in the terminal; anything else opens in your browser.

| Key | |
|---|---|
| `tab` `↑↓←→` `hjkl` | move between cards |
| `enter` / click | open that card's page |
| `w` | open it in your browser instead |
| `s` | account settings |
| `r` | refresh now |
| `o` | sign out this terminal |
| `q` | quit |

On every page `esc` goes back, `w` opens the same page in your browser and `q` quits. `g` then a letter jumps around, as on the website: `g h` home, `g d` Drift, `g p` plugin store, `g c` chat, `g r` Recipe box, `g s` settings, `g n` notifications, `g a` admin, `g o` sign out.

## Book club pick

The public `/books/` page, where the book club picks its next book: each book with its description, where to get it and its votes so far. It works without signing in. This terminal gets one vote, kept under its own id in `~/.config/sintfoap/books.json`; votes from here show the computer's name to admins. Signed in as an admin, a "Who voted" list follows the books.

| Key | |
|---|---|
| `↑↓` `jk` | move between books |
| `enter` / `v` | vote for it (on your vote: take it back) |
| `u` | take your vote back |
| `o` | where to get it: pick one to open in your browser |
| `n` | the name your vote is under |
| `x` | admins, on the Who voted list: remove that vote |

## Drift

Your collections down the left (`tab` to move between them, the composer and the items), with Today and Calendar on top. Calendar shows the picked day by the hour, under a "No set time" list for items with a date but no time. A collection shows its plugins' views: Checklist, Calendar and List, Graph as a list of links with their types and each item's kind, and Map: the picked day's events that have a place, drawn on a map in characters, numbered and joined in the order they happen, with the distance from each to the one before, then the day's events with no place. Moving to one centres the map on it and names it under the map; `o` opens it in OpenStreetMap. The day's base (where it starts and ends) is at the top: `b` sets one for the day, a stretch of days, or every day. `p` plans the route from the base and back, keeping timed events in order and linked items together, with the travel time of each leg; `m` switches between driving, walking and cycling, and `(` `)` cycle through the other good orders. Changes made in the browser or by people you share with show up within a few seconds.

The composer takes the same quick-add as the web page: `Lunch #family +home !2 ^fri @1pm ~ Ferry Building, San Francisco` (after `~`, the place).

| Key (on the items) | |
|---|---|
| `a` | add an item |
| `enter` / `e` | edit it: title, notes, tags, collection, priority, date and time, place (an address, a place's name or coordinates; the site finds it) |
| `x` / `space` | tick it off |
| `0`–`3` | priority |
| `t` | date it today |
| `d` | delete (`u` undoes) |
| `v` | next view |
| `h` | show or hide done items |
| `>` `<` `K` `J` | List: nest, unnest, move up, move down |
| `[` `]` `{` `}` `.` | Calendar: day, month, today (Map: `[` `]` `.`) |
| `o` | open the item's place in OpenStreetMap |
| `b` | Map: set or change the day's base |
| `p` `m` `(` `)` | Map: route on or off, drive / walk / cycle, other orders |
| `/` | search |
| `c` | the collection's plugins and sharing (or leave one shared with you) |
| `N` | new collection |

Store plugins run only in the browser's sandbox, so their data is kept as it is here and their views are on `w`.

## Plugin store

`1` the store: `enter` shows a plugin and its code, `i` adds it to Drift or removes it. `2` your plugins: `n` starts one from the same example as the website, and the editor saves drafts (`ctrl+s`), submits them for review (`ctrl+r`) and withdraws or deletes them. Admins get `3`, the review queue, with each submission compared line by line to the live version and Approve or Reject (with a note). Nothing in the terminal runs plugin code; "Try it" is on the website.

## Chat

The same rooms as `/chat/`: the list on the left, the open room on the right, and a line to type in. It opens the room you name, or your first room, and checks for new messages every few seconds, like the web page. The dashboard's Chat card opens it too.

| | |
|---|---|
| `enter` | send what you typed (only in rooms you've joined); `@name` mentions someone |
| `tab` | after an `@`, complete a name from the room; otherwise move to the room list |
| `esc` | move to the room list; `enter` on a room opens it (`esc` there goes back) |
| `/edit [TEXT]` | change your last message; on its own (or `↑` on an empty line) it puts the message on the line to change |
| `/react NAME` | react to the last message from someone else, or take it back: `+1` `heart` `laugh` `tada` `wow` `sad` `eyes` `pray` |
| `/join` `/leave` | join or leave the open room |
| `/new NAME \| TOPIC` | make a room anyone can join (`ctrl+n` starts this for you) |
| `/private NAME \| TOPIC` | make a room only people you add can see |
| `/add NAME` `/remove NAME` | add someone to a private room, or take them out (its owner) |
| `/dm NAME` | open your direct messages with someone; `tab` completes names |
| `/who` | who's in the room, and who's online (●) |
| `/connections` | your connections to other platforms (Matrix); their rooms are in the list marked `~` |
| `/connect` | connect an account there; the form is the website's, with secrets typed hidden |
| `/disconnect N` `/sync [N]` | remove connection N, or sync now (and retry one that stopped working) |
| `/search TEXT` | find messages in the room; `esc` or `/search` on its own goes back |
| `/rename NAME` `/topic TEXT` | change the open room (its owner, or an admin) |
| `/delete` | delete your last message in the open room |
| `/older` | load older messages (`ctrl+u`) |
| `/gif [TEXT]` | the GIF picker (`ctrl+g`): favorites, trending and categories, or a search for TEXT; `enter` sends the highlighted GIF, `ctrl+s` stars it |
| `/star` | star the last GIF in the room for your favorites (again to unstar) |
| `/help` | these commands |

Start a message with `//` to send one that begins with `/`. GIFs show as `GIF` and their link (the web page shows the picture). Messages that mention you are marked with a bar, reactions show under a message, and a room where you were mentioned shows `@` in the list. Rooms are marked `#` (open), `*` (private) or `@` (direct message, with ● when they're online). The line above where you type says who else has the room open, or who's typing.

## Notifications

The same settings as `/notifications/`: what Chat and Drift push to you (direct messages, @mentions, every message in rooms you've joined, messages from your Matrix connections, Drift reminders and how long before), and the list of browsers they go to. `space` switches a setting, Remove takes a browser off the list, and `t` sends a test to all of them. A terminal can't receive push notifications itself, so turning them on for a browser or phone happens there: `w` opens the page.

## Recipe box

The same recipes as `/recipes/`: the list on the left, the open one on the right. Paste a link to a recipe page in the box at the top (`a` goes there) and the site reads the recipe off it, from the schema.org data most recipe sites publish, or from a recipe shared out of Recipe Keeper (recipekeeperonline.com). If a page has no recipe on it, the editor opens with the link filled in so you can type it.

| Key | |
|---|---|
| `a` | save a recipe from a link |
| `n` | type one in by hand |
| `+` `-` | more or fewer servings (or ×½ steps for a recipe that doesn't say how many it serves); quantities change to match |
| `space` | on the ingredients: tick which to send |
| `s` | send the ticked ingredients, scaled, to a Drift list: your Shopping list (made the first time), or any list you can add to |
| `e` | edit it (`ctrl+s` saves) |
| `d` | delete it |

## Account settings

Your profile, two-factor, recovery codes, email and sessions, like `/account`. Here you can change your display name, sign out every other device, or sign out this terminal. Anything that needs your password (two-factor, recovery codes, email, the password itself) opens the website instead, so the terminal never asks for it.

## Files

```
sintfoap/site.py           signing in and out, and the site's JSON APIs (stdlib)
sintfoap/tui.py            the app and the dashboard (Textual)
sintfoap/look.py           colours, the top bar and dialogs every page shares
sintfoap/drift_page.py     Drift
sintfoap/drift_rules.py    quick-add, dates and ordering, as on the web page
sintfoap/store_page.py     the plugin store
sintfoap/settings_page.py  account settings
sintfoap/chat_page.py      chat
sintfoap/notifications_page.py  what's pushed and where
sintfoap/recipes_page.py   Recipe box
sintfoap/recipe_rules.py   scaling ingredient lines, as on the web page (tests/scale_cases.json keeps them the same)
sintfoap/__main__.py       the command
tests/                     python -m pytest tests
tests/devsite.mjs          the site's real Worker on localhost, for tests/test_pages.py (needs node 22)
```

The site's side is `src/cli.js` (signing in, the dashboard and settings) and the same `/todo/api/` and `/plugins/api/` the web pages use.

## Admin

For admins: every account, with a switch for each app on the site (the same list as the website's menu, so a new app shows up here by itself, off for everyone). `tab` moves between switches and `space` turns one on or off; your own Admin switch stays on. Passwords, two-factor and disabling or deleting accounts are on the website: `w` opens `/admin`.
