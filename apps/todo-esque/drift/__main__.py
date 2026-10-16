"""
drift — decentralized tasks.

  drift                       open the terminal UI
  drift tui                   same
  drift web [--port 7878]     serve the web UI (add --host 0.0.0.0 --token X for LAN)
  drift add "Pay rent #home ^1st !3"
  drift ls [--all] [--project P] [--tag T]
  drift done <id-prefix>
  drift rm <id-prefix>
  drift info                  vault, node id, nodes seen

Global:  --vault PATH   (default $DRIFT_VAULT or ~/Drift)
"""
from __future__ import annotations

import argparse
import sys

from .core import Store, bucket

C = {"dim": "\033[2m", "b": "\033[1m", "r": "\033[0m", "red": "\033[38;5;203m",
     "amb": "\033[38;5;215m", "grn": "\033[38;5;114m", "blu": "\033[38;5;111m",
     "vio": "\033[38;5;183m"}
if not sys.stdout.isatty():
    C = {k: "" for k in C}


def _find(store: Store, prefix: str):
    p = prefix if prefix.startswith("t_") else "t_" + prefix
    hits = [t for t in store.tasks() if t.id.startswith(p)]
    if len(hits) != 1:
        sys.exit(f"drift: {'no' if not hits else 'ambiguous'} task matching {prefix!r}")
    return hits[0]


def _line(t) -> str:
    b = bucket(t)
    box = f"{C['grn']}✓{C['r']}" if t.done else "○"
    pri = {3: f"{C['red']}!!!{C['r']} ", 2: f"{C['amb']}!!{C['r']} ",
           1: f"{C['blu']}!{C['r']} "}.get(t.priority, "")
    due = ""
    if t.due:
        col = {"overdue": C["red"], "today": C["amb"]}.get(b, C["dim"])
        due = f"  {col}{t.due}{C['r']}"
    proj = f"  {C['vio']}+{t.project}{C['r']}" if t.project else ""
    tags = "".join(f" {C['dim']}#{g}{C['r']}" for g in t.tags)
    title = f"{C['dim']}{t.title}{C['r']}" if t.done else t.title
    return f" {C['dim']}{t.id[2:8]}{C['r']} {box} {pri}{title}{due}{proj}{tags}"


def main(argv=None):
    ap = argparse.ArgumentParser(prog="drift", description="decentralized tasks")
    ap.add_argument("--vault")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("tui")
    w = sub.add_parser("web")
    w.add_argument("--host", default="127.0.0.1")
    w.add_argument("--port", type=int, default=7878)
    w.add_argument("--token")
    a = sub.add_parser("add")
    a.add_argument("text", nargs="+")
    ls = sub.add_parser("ls")
    ls.add_argument("--all", action="store_true")
    ls.add_argument("--project")
    ls.add_argument("--tag")
    for name in ("done", "rm"):
        sub.add_parser(name).add_argument("id")
    sub.add_parser("info")
    args = ap.parse_args(argv)

    store = Store(args.vault)
    cmd = args.cmd or "tui"

    if cmd == "tui":
        from .tui import run
        run(store)
    elif cmd == "web":
        from .server import serve
        serve(store, args.host, args.port, args.token)
    elif cmd == "add":
        t = store.quick_add(" ".join(args.text))
        print(_line(t))
    elif cmd == "ls":
        ts = [t for t in store.tasks() if args.all or not t.done]
        if args.project:
            ts = [t for t in ts if t.project == args.project]
        if args.tag:
            ts = [t for t in ts if args.tag.lstrip("#") in t.tags]
        if not ts:
            print(f"  {C['dim']}nothing here — enjoy the calm.{C['r']}")
        for t in ts:
            print(_line(t))
    elif cmd == "done":
        print(_line(store.toggle(_find(store, args.id).id)))
    elif cmd == "rm":
        t = _find(store, args.id)
        store.delete(t.id)
        print(f"  removed  {t.title}")
    elif cmd == "info":
        s = store.stats()
        print(f"  vault  {s['vault']}\n  node   {s['node']}\n"
              f"  nodes  {', '.join(s['nodes'])}\n  open   {s['open']}   done {s['done']}")


if __name__ == "__main__":
    main()
