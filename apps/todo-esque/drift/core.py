"""
Drift core — a decentralized, UI-agnostic task store.

Model
-----
* Every device ("node") appends operations to its OWN log file:
      <vault>/log/<node-id>.jsonl
  No two devices ever write the same file, so any dumb file-sync tool
  (Syncthing, Dropbox, iCloud, git, rsync, a USB stick) can move the
  vault around without write conflicts.

* An operation sets ONE field of ONE task:
      {"id": "t_ab12…", "f": "title", "v": "Buy milk", "t": "<hlc>"}

* Each op carries a Hybrid Logical Clock stamp (wall-ms, counter, node).
  HLC stamps are totally ordered and respect causality even when device
  clocks drift, so "last writer wins" per field is deterministic.

* State = fold(all ops from all logs). Because the merge is per-field
  LWW (a CRDT), every device that has seen the same set of ops computes
  exactly the same state, in any order. That's the whole sync story.

Frontends (TUI, web server, CLI, scripts) only ever talk to `Store`.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import socket
import threading
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Iterable

FIELDS = {
    "title": str,
    "notes": str,
    "done": bool,
    "priority": int,      # 0 none, 1 low, 2 medium, 3 high
    "due": (str, type(None)),   # YYYY-MM-DD or None
    "project": str,
    "tags": list,
    "order": float,
    "created": str,
    "completed_at": (str, type(None)),
    "deleted": bool,
}
DEFAULTS = {
    "title": "", "notes": "", "done": False, "priority": 0, "due": None,
    "project": "", "tags": [], "order": 0.0, "created": "",
    "completed_at": None, "deleted": False,
}


# ─────────────────────────── Hybrid Logical Clock ───────────────────────────

class HLC:
    """Hybrid logical clock. Stamps look like 0001760541234567-0003-laptop-x1."""

    def __init__(self, node: str):
        self.node = node
        self.wall = 0
        self.count = 0
        self._lock = threading.Lock()

    @staticmethod
    def parse(stamp: str) -> tuple[int, int, str]:
        w, c, n = stamp.split("-", 2)
        return int(w), int(c), n

    def _fmt(self) -> str:
        return f"{self.wall:016d}-{self.count:04d}-{self.node}"

    def now(self) -> str:
        with self._lock:
            pt = int(time.time() * 1000)
            if pt > self.wall:
                self.wall, self.count = pt, 0
            else:
                self.count += 1
            return self._fmt()

    def observe(self, stamp: str) -> None:
        """Advance past a stamp received from another node."""
        w, c, _ = self.parse(stamp)
        with self._lock:
            if w > self.wall or (w == self.wall and c >= self.count):
                self.wall, self.count = w, c


# ─────────────────────────────── Task view ──────────────────────────────────

@dataclass
class Task:
    id: str
    title: str = ""
    notes: str = ""
    done: bool = False
    priority: int = 0
    due: str | None = None
    project: str = ""
    tags: list[str] = field(default_factory=list)
    order: float = 0.0
    created: str = ""
    completed_at: str | None = None
    deleted: bool = False
    updated: str = ""   # newest HLC that touched this task

    def to_dict(self) -> dict[str, Any]:
        d = self.__dict__.copy()
        d["bucket"] = bucket(self)
        return d


def bucket(t: Task, today: date | None = None) -> str:
    """Where a task sits on the timeline: done/overdue/today/upcoming/someday."""
    if t.done:
        return "done"
    if not t.due:
        return "someday"
    today = today or date.today()
    try:
        d = date.fromisoformat(t.due)
    except ValueError:
        return "someday"
    if d < today:
        return "overdue"
    if d == today:
        return "today"
    return "upcoming"


# ──────────────────────────────── Store ─────────────────────────────────────

def default_vault() -> Path:
    return Path(os.environ.get("DRIFT_VAULT", Path.home() / "Drift")).expanduser()


def _node_id_path() -> Path:
    base = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state"))
    return base / "drift" / "node-id"


def local_node_id() -> str:
    """Stable per-device id. Lives OUTSIDE the vault so it never syncs."""
    if os.environ.get("DRIFT_NODE"):
        return os.environ["DRIFT_NODE"]
    p = _node_id_path()
    if p.exists():
        return p.read_text().strip()
    host = re.sub(r"[^a-z0-9]+", "", socket.gethostname().lower())[:12] or "node"
    nid = f"{host}-{secrets.token_hex(3)}"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(nid)
    return nid


class Store:
    def __init__(self, vault: Path | str | None = None, node: str | None = None):
        self.vault = Path(vault).expanduser() if vault else default_vault()
        self.node = node or local_node_id()
        self.logdir = self.vault / "log"
        self.logdir.mkdir(parents=True, exist_ok=True)
        self.my_log = self.logdir / f"{self.node}.jsonl"
        self.clock = HLC(self.node)
        # id -> field -> (stamp, value)
        self._cells: dict[str, dict[str, tuple[str, Any]]] = {}
        self._offsets: dict[str, int] = {}
        self._lock = threading.RLock()
        self.version = 0
        self._listeners: list[Callable[[], None]] = []
        self.refresh()

    # ── reading ────────────────────────────────────────────────────────
    def refresh(self) -> bool:
        """Read any new bytes from every log. Returns True if state changed."""
        changed = False
        with self._lock:
            for path in sorted(self.logdir.glob("*.jsonl")):
                key = path.name
                off = self._offsets.get(key, 0)
                try:
                    size = path.stat().st_size
                except FileNotFoundError:
                    continue
                if size < off:          # file was replaced; re-read from scratch
                    off = 0
                if size == off:
                    continue
                with path.open("rb") as fh:
                    fh.seek(off)
                    chunk = fh.read()
                # only consume complete lines (a sync tool may deliver half a write)
                end = chunk.rfind(b"\n") + 1
                for line in chunk[:end].splitlines():
                    if line.strip():
                        try:
                            changed |= self._apply(json.loads(line))
                        except (ValueError, KeyError):
                            pass        # tolerate junk lines
                self._offsets[key] = off + end
            if changed:
                self.version += 1
        if changed:
            for fn in list(self._listeners):
                try:
                    fn()
                except Exception:
                    pass
        return changed

    def _apply(self, op: dict) -> bool:
        tid, f, v, t = op["id"], op["f"], op["v"], op["t"]
        if f not in FIELDS:
            return False
        self.clock.observe(t)
        cells = self._cells.setdefault(tid, {})
        cur = cells.get(f)
        if cur is None or t > cur[0]:       # LWW; stamps sort lexically
            cells[f] = (t, v)
            return True
        return False

    def get(self, tid: str) -> Task | None:
        with self._lock:
            cells = self._cells.get(tid)
            if not cells:
                return None
            vals = {k: (cells[k][1] if k in cells else
                        (list(v) if isinstance(v, list) else v))
                    for k, v in DEFAULTS.items()}
            return Task(id=tid, updated=max(c[0] for c in cells.values()), **vals)

    def tasks(self, include_deleted: bool = False) -> list[Task]:
        with self._lock:
            out = [self.get(t) for t in self._cells]
        out = [t for t in out if t and (include_deleted or not t.deleted)]
        out.sort(key=sort_key)
        return out

    def projects(self) -> list[str]:
        return sorted({t.project for t in self.tasks() if t.project})

    def tags(self) -> list[str]:
        return sorted({g for t in self.tasks() for g in t.tags})

    # ── writing ────────────────────────────────────────────────────────
    def _write(self, ops: Iterable[dict]) -> None:
        ops = list(ops)
        if not ops:
            return
        data = "".join(json.dumps(o, separators=(",", ":")) + "\n" for o in ops)
        with self._lock:
            with self.my_log.open("a", encoding="utf-8") as fh:
                fh.write(data)
                fh.flush()
                os.fsync(fh.fileno())
        self.refresh()

    def _ops(self, tid: str, changes: dict[str, Any]) -> list[dict]:
        ops = []
        for f, v in changes.items():
            if f not in FIELDS:
                raise KeyError(f"unknown field {f!r}")
            ops.append({"id": tid, "f": f, "v": _coerce(f, v), "t": self.clock.now()})
        return ops

    def add(self, title: str, **fields: Any) -> Task:
        tid = "t_" + secrets.token_hex(5)
        now = datetime.now().isoformat(timespec="seconds")
        base = {"title": title.strip(), "created": now,
                "order": fields.pop("order", time.time())}
        base.update(fields)
        self._write(self._ops(tid, base))
        return self.get(tid)  # type: ignore[return-value]

    def update(self, tid: str, **changes: Any) -> Task:
        if self.get(tid) is None:
            raise KeyError(tid)
        if "done" in changes:
            changes.setdefault("completed_at",
                               datetime.now().isoformat(timespec="seconds")
                               if changes["done"] else None)
        self._write(self._ops(tid, changes))
        return self.get(tid)  # type: ignore[return-value]

    def toggle(self, tid: str) -> Task:
        t = self.get(tid)
        if t is None:
            raise KeyError(tid)
        return self.update(tid, done=not t.done)

    def delete(self, tid: str) -> None:
        self.update(tid, deleted=True)

    def quick_add(self, text: str) -> Task:
        title, fields = parse_quick(text)
        return self.add(title, **fields)

    # ── live updates ───────────────────────────────────────────────────
    def subscribe(self, fn: Callable[[], None]) -> None:
        self._listeners.append(fn)

    def watch(self, interval: float = 0.75) -> threading.Thread:
        """Poll the vault for changes made by other devices/processes."""
        def loop():
            while True:
                time.sleep(interval)
                try:
                    self.refresh()
                except Exception:
                    pass
        th = threading.Thread(target=loop, daemon=True, name="drift-watch")
        th.start()
        return th

    # ── maintenance ────────────────────────────────────────────────────
    def stats(self) -> dict[str, Any]:
        ts = self.tasks()
        nodes = sorted(p.stem for p in self.logdir.glob("*.jsonl"))
        return {
            "vault": str(self.vault), "node": self.node, "nodes": nodes,
            "open": sum(not t.done for t in ts), "done": sum(t.done for t in ts),
            "version": self.version,
        }


def sort_key(t: Task):
    b = {"overdue": 0, "today": 1, "upcoming": 2, "someday": 3, "done": 4}[bucket(t)]
    return (b, t.due or "9999", -t.priority, t.order)


def _coerce(f: str, v: Any) -> Any:
    if f == "priority":
        return max(0, min(3, int(v or 0)))
    if f == "tags":
        if isinstance(v, str):
            v = [x for x in re.split(r"[,\s]+", v) if x]
        return sorted({str(x).lstrip("#").lower() for x in v if str(x).strip("# ")})
    if f in ("done", "deleted"):
        return bool(v)
    if f == "order":
        return float(v)
    if f == "due":
        return parse_date(v) if v else None
    if f in ("title", "notes", "project"):
        return str(v or "").strip()
    return v


# ───────────────────────── quick-add mini-language ──────────────────────────
#   "Call mom about flights #family +travel !2 ^fri"
#   #tag   +project   !1-3 (or !, !!, !!!) priority   ^date due

_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def parse_date(s: Any, today: date | None = None) -> str | None:
    if s is None:
        return None
    s = str(s).strip().lower()
    if not s:
        return None
    today = today or date.today()
    if s in ("tod", "today", "now"):
        return today.isoformat()
    if s in ("tom", "tmr", "tomorrow"):
        return (today + timedelta(days=1)).isoformat()
    if s in ("week", "nextweek", "next-week"):
        return (today + timedelta(days=7 - today.weekday())).isoformat()
    m = re.fullmatch(r"\+?(\d+)([dw])", s)
    if m:
        n = int(m.group(1)) * (7 if m.group(2) == "w" else 1)
        return (today + timedelta(days=n)).isoformat()
    for i, wd in enumerate(_WEEKDAYS):
        if s.startswith(wd[:3]) and wd.startswith(s[:3]):
            delta = (i - today.weekday()) % 7 or 7
            return (today + timedelta(days=delta)).isoformat()
    for fmt in ("%Y-%m-%d", "%m/%d", "%m-%d", "%b%d", "%d%b"):
        try:
            d = datetime.strptime(s, fmt).date()
            if "%Y" not in fmt:
                d = d.replace(year=today.year)
                if d < today:
                    d = d.replace(year=today.year + 1)
            return d.isoformat()
        except ValueError:
            pass
    return None


def parse_quick(text: str) -> tuple[str, dict[str, Any]]:
    fields: dict[str, Any] = {}
    tags: list[str] = []
    words = []
    for w in text.split():
        if len(w) > 1 and w[0] == "#":
            tags.append(w[1:])
        elif len(w) > 1 and w[0] == "+":
            fields["project"] = w[1:]
        elif re.fullmatch(r"!{1,3}|![0-3]", w):
            fields["priority"] = int(w[1]) if w[1:].isdigit() else len(w)
        elif len(w) > 1 and w[0] == "^" and parse_date(w[1:]):
            fields["due"] = parse_date(w[1:])
        else:
            words.append(w)
    if tags:
        fields["tags"] = tags
    return " ".join(words), fields
