"""Admin stats in the terminal: the same numbers as /admin/stats.

How many accounts there are against MAX_USERS and who's been active, how full
D1 is (and what's moved to R2), then each person's things and storage, biggest
first, and the totals app by app. Admins only; t on the admin page opens it."""
from __future__ import annotations

import time

from rich.table import Table
from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import VerticalScroll
from textual.widgets import Footer, Static

from . import site
from .look import BAD, FAINT, GOLD, GOLD_DIM, INK, LINE, MUTED, Page, attempt, plural

WARN = "#e0b25a"


def size(n: float | None) -> str:
    """1234567 → "1.2 MB", as the website writes it."""
    if n is None:
        return "—"
    units, i = ["B", "KB", "MB", "GB"], 0
    while n >= 1024 and i < len(units) - 1:
        n /= 1024
        i += 1
    return f"{n:.1f} {units[i]}" if i and n < 10 else f"{round(n)} {units[i]}"


def ago(t: int | None, now: int | None = None) -> str:
    if not t:
        return "never"
    s = max(0, (now or int(time.time())) - t)
    if s < 120:
        return "just now"
    if s < 3600:
        return f"{s // 60} min ago"
    if s < 86400:
        return f"{s // 3600} h ago"
    d = s // 86400
    return plural(d, "day") + " ago" if d < 60 else time.strftime("%Y-%m-%d", time.gmtime(t))


def meter(part: float, whole: float, width: int = 24, share: bool = False) -> Text:
    """A bar for part of whole; a `share` bar (one person against the biggest) stays gold."""
    f = min(1.0, part / whole) if whole else 0.0
    full = round(width * f)
    colour = GOLD if share else BAD if f >= 0.9 else WARN if f >= 0.7 else GOLD
    return Text.assemble(("━" * full, colour), ("━" * (width - full), LINE))


def summary(s: dict) -> Text:
    a, d1 = s["accounts"], s["storage"]["d1"]
    kept = d1["bytes"] if d1["bytes"] is not None else d1["data_bytes"] + d1["photo_bytes"]
    t = Text.assemble((f"{a['total']}", f"bold {GOLD}"), (f" / {a['max']} accounts", INK), ("  (MAX_USERS)  ", FAINT))
    t.append_text(meter(a["total"], a["max"]))
    t.append(f"   signups {a['signups']}, {plural(a['left'], 'place')} left\n", style=MUTED)
    t.append_text(Text.assemble((f"{a['active_7d']}", f"bold {GOLD}"), (" active this week   ", INK),
                                (f"{a['active_30d']}", f"bold {GOLD}"), (" in 30 days   ", INK),
                                (f"{a['joined_30d']}", f"bold {GOLD}"), (" joined in 30 days", INK)))
    return t


def storage(s: dict) -> Text:
    a, d1, r2 = s["accounts"], s["storage"]["d1"], s["storage"]["r2"]
    rows = d1["data_bytes"] + d1["photo_bytes"]
    t = Text()
    if d1["bytes"] is not None:
        t.append_text(Text.assemble(("D1  ", f"bold {INK}"), (size(d1["bytes"]), f"bold {GOLD}"), (f" of {size(d1['limit_bytes'])}  ", MUTED)))
        t.append_text(meter(d1["bytes"], d1["limit_bytes"], 32))
        t.append(f"  {round(100 * d1['bytes'] / d1['limit_bytes'])}%\n" if d1["limit_bytes"] else "\n", style=MUTED)
    else:
        t.append("D1 didn't say how big the database is, so this counts the rows.\n", style=FAINT)
    t.append_text(Text.assemble(("    people's things ", MUTED), (size(d1["data_bytes"]), INK),
                                ("   pictures in D1 ", MUTED), (size(d1["photo_bytes"]), INK), (f" ({plural(d1['photo_count'], 'picture')})\n", FAINT)))
    t.append("R2  ", style=f"bold {INK}")
    if r2["bound"]:
        t.append_text(Text.assemble((size(r2["bytes"]), f"bold {GOLD}"), (f" across {plural(r2['photo_count'], 'picture')}", MUTED),
                                    (" (more than could be listed)" if r2["partial"] else "", FAINT)))
    elif r2["photo_count"]:
        t.append(f"{plural(r2['photo_count'], 'picture')} there; sizes show once the PHOTOS bucket is bound", style=MUTED)
    else:
        t.append("no pictures there yet", style=MUTED)
    each = rows / a["total"] if a["total"] else 0
    t.append(f"\n\nAbout {size(each)} a person: {a['max']} accounts would keep about {size(each * a['max'])} in D1.", style=FAINT)
    return t


def people_table(s: dict) -> Table:
    tb = Table(box=None, expand=True, header_style=FAINT, pad_edge=False)
    tb.add_column("WHO", style=INK, no_wrap=True)
    tb.add_column("LAST ACTIVE", style=MUTED, no_wrap=True)
    tb.add_column("APPS", justify="right")
    for c in s["columns"]:
        tb.add_column(c["name"].upper(), justify="right")
    tb.add_column("STORAGE", justify="right", no_wrap=True)
    tb.add_column("", no_wrap=True)
    top = max([1, *[u["total_bytes"] for u in s["users"]]])
    num = lambda n: Text(f"{n:,}", style=INK if n else FAINT)  # noqa: E731
    for u in s["users"]:
        who = Text(u["display_name"], style=f"bold {INK}")
        if u["display_name"].lower() != u["username"]:
            who.append(f" {u['username']}", style=GOLD_DIM)
        if u["disabled"]:
            who.append(" disabled", style=BAD)
        cols = [num(sum(u["counts"].get(i, 0) for i in c["ids"])) for c in s["columns"]]
        tb.add_row(who, ago(u["last_active"], s["now"]), num(len(u["apps"])), *cols,
                   Text(size(u["total_bytes"]), style=INK), meter(u["total_bytes"], top, 12, share=True))
    return tb


def apps_table(s: dict) -> Table:
    tb = Table(box=None, expand=True, header_style=FAINT, pad_edge=False)
    tb.add_column("WHAT", style=INK)
    tb.add_column("APP", style=GOLD_DIM)
    tb.add_column("COUNT", justify="right")
    tb.add_column("PICTURES", justify="right", style=MUTED)
    for k in s["kinds"]:
        n = s["totals"]["counts"].get(k["id"], 0)
        ph = s["totals"]["photos"].get(k["id"]) if k.get("photos") else None
        where = f"{size(ph['d1_bytes'])} in D1" + (f" · {size(ph['r2_bytes'])} in R2" if ph["r2_bytes"] else "") if ph else ""
        tb.add_row(k["label"], k.get("app_name", k["app"]), Text(f"{n:,}", style=INK if n else FAINT), where)
    return tb


class StatsPage(Page):
    WEB_PATH = "/admin/stats"
    DEFAULT_CSS = """
    StatsPage #body { padding: 0 4 1 4; }
    """
    BINDINGS = [Binding("r", "refresh", "Refresh")]

    def __init__(self):
        super().__init__()
        self.data: dict | None = None

    def compose(self) -> ComposeResult:
        yield from self.top()
        with VerticalScroll(id="body"):
            yield Static("A D M I N", classes="kicker")
            yield Static(Text("Stats", style=f"bold {INK}"), classes="h1")
            yield Static(Text("Accounts against MAX_USERS, how full D1 is, and what each person keeps, biggest first. "
                              "Last active is the latest of a signed-in page, an API key or a chat message.", style=MUTED), classes="sub")
            yield Static(id="summary", classes="card")
            yield Static(id="storage", classes="card")
            yield Static(id="people", classes="card")
            yield Static(id="apps", classes="card")
        yield Footer()

    async def on_mount(self) -> None:
        super().on_mount()
        await self.action_refresh()

    @attempt
    async def action_refresh(self) -> None:
        self.show(await self.fetch(site.admin_stats))

    def show(self, s: dict) -> None:
        self.data = s
        self.query_one("#summary", Static).update(summary(s))
        st = self.query_one("#storage", Static)
        st.border_title = "Storage"
        st.update(storage(s))
        pp = self.query_one("#people", Static)
        pp.border_title = "1 person" if len(s["users"]) == 1 else f"{len(s['users'])} people"
        pp.update(people_table(s))
        ap = self.query_one("#apps", Static)
        ap.border_title = "By app"
        ap.update(apps_table(s))
