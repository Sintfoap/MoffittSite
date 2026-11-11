"""
sintfoap — sintfoap.xyz from the terminal.

  sintfoap                    your dashboard (signs in first if needed)
  sintfoap login [--site URL] sign in: shows a code to approve in your browser
  sintfoap dashboard [--plain]
  sintfoap drift              Drift, in the terminal
  sintfoap store              the plugin store
  sintfoap settings           your account settings
  sintfoap chat [ROOM]        chat rooms
  sintfoap notifications      what's pushed to your browsers and phone
  sintfoap recipes            Recipe box: recipes, scaled, onto a Drift shopping list
  sintfoap meals              Meal plan: the week's dinners around your Drift calendar
  sintfoap pantry             Pantry: your food, how much is left, and what to use soon
  sintfoap sweep              Sweep: Drift suggestions from your chat rooms
  sintfoap trips              Trip planner: the days, places and packing list, with whoever's going
  sintfoap board              Recipe board: recipes shared by their labels, and a feed of the keys you follow
  sintfoap labels             Recipe labels: the one list of labels recipes pick from
  sintfoap food               Food club: the month's food, its recipe, favorites and everyone's photos
  sintfoap feedback           Feedback: notes to the site's owner, with photos and links (admins: the inbox)
  sintfoap admin              which apps each account can use (admins)
  sintfoap stats              accounts, who's active and how much each keeps in D1 and R2 (admins)
  sintfoap app                the Android app: a QR code to scan, and the download
  sintfoap whoami
  sintfoap logout             ends this terminal's session on the site
"""
from __future__ import annotations

import argparse
import sys

from . import site

C = {"dim": "\033[2m", "b": "\033[1m", "r": "\033[0m", "gold": "\033[38;5;179m",
     "red": "\033[38;5;174m", "grn": "\033[38;5;114m"}
if not sys.stdout.isatty():
    C = {k: "" for k in C}


def plain(data: dict) -> None:
    """The dashboard as text, for pipes and terminals without the full UI."""
    u, a = data["user"], data["account"]
    print(f"\n  {C['gold']}DASHBOARD{C['r']}  {C['dim']}{data['site']}{C['r']}\n"
          f"  {C['b']}Welcome, {u['display_name']}{C['r']}\n")
    if a.get("setup_needed"):
        print(f"  {C['red']}Finish setting up your account first: {a['setup_needed']}.{C['r']}\n  {a['url']}\n")
    for app in data["apps"]:
        print(f"  {C['b']}{app['name']}{C['r']}  {C['dim']}{app['blurb']}{C['r']}\n  {C['gold']}{app['url']}{C['r']}\n")
    if not data["apps"] and not a.get("setup_needed"):
        print(f"  {C['dim']}Your account doesn't have any apps yet. Ask the site's admin for access.{C['r']}\n")
    two = f"{C['grn']}on{C['r']}" if a["two_factor"] else f"{C['red']}off{C['r']}"
    n, left = a["sessions"], a["recovery_codes_left"]
    email = ""
    if a.get("email"):
        email = f"  Email {a['email']} " + ("is confirmed." if a["email_confirmed"] else "isn't confirmed yet.")
    print(f"  {C['b']}Your account{C['r']}\n"
          f"  Signed in as {u['username']}. Two-factor is {two}. Signed in on {n} device{'s' * (n != 1)}.\n"
          f"  {left} recovery code{'s' * (left != 1)} left.{email}\n"
          f"  {C['gold']}{a['url']}{C['r']}\n")


def app_info(data: dict) -> None:
    """Where to get the Android app: a QR code for the phone, and the links."""
    print(f"\n  {C['gold']}THE PHONE APP{C['r']}  {C['dim']}scan with your phone's camera{C['r']}\n")
    for line in data["qr"].rstrip("\n").split("\n"):
        print("  " + line)
    print(f"\n  {C['gold']}{data['page']}{C['r']}")
    if data.get("version"):
        print(f"  Version {data['version']}: {C['dim']}{data['url']}{C['r']}")
    else:
        print(f"  {C['dim']}No APK yet. Install it from Chrome instead: {data['page'].removesuffix('/app')}/m/, then ⋮ → Install app.{C['r']}")
    print()


def main(argv=None):
    ap = argparse.ArgumentParser(prog="sintfoap", description="sintfoap.xyz from the terminal")
    sub = ap.add_subparsers(dest="cmd")
    lg = sub.add_parser("login", help="sign in by approving a code in your browser")
    lg.add_argument("--site", help=f"default $SINTFOAP_SITE or {site.DEFAULT_SITE}")
    lg.add_argument("--no-browser", action="store_true", help="just print the link")
    d = sub.add_parser("dashboard", help="your dashboard")
    d.add_argument("--plain", action="store_true", help="print it instead of opening the terminal UI")
    for page, what in (("drift", "Drift, in the terminal"), ("store", "the plugin store"), ("settings", "your account settings"),
                       ("notifications", "what's pushed to your browsers and phone"),
                       ("recipes", "Recipe box: recipes, scaled, onto a Drift shopping list"),
                       ("meals", "Meal plan: the week's dinners around your Drift calendar"),
                       ("pantry", "Pantry: your food, how much is left, and what to use soon"),
                       ("sweep", "Sweep: Drift suggestions from your chat rooms"),
                       ("trips", "Trip planner: the days, places and packing list, with whoever's going"),
                       ("board", "Recipe board: recipes shared by their labels, and a feed of the keys you follow"),
                       ("labels", "Recipe labels: the one list of labels recipes pick from"),
                       ("food", "Food club: the month's food, its recipe, favorites and everyone's photos"),
                       ("feedback", "Feedback: notes to the site's owner, with photos and links (admins: the inbox)"),
                       ("admin", "which apps each account can use (admins)"),
                       ("stats", "accounts, who's active and how much each keeps in D1 and R2 (admins)")):
        sub.add_parser(page, help=what)
    ch = sub.add_parser("chat", help="chat rooms")
    ch.add_argument("room", nargs="?", help="a room to open, by name")
    sub.add_parser("app", help="the Android app: a QR code to scan, and the download")
    sub.add_parser("whoami")
    sub.add_parser("logout")
    args = ap.parse_args(argv)
    cmd = args.cmd or "dashboard"
    try:
        if cmd == "login":
            info = site.login(args.site, open_browser=not args.no_browser)
            print(f"\n  {C['grn']}✓{C['r']} signed in to {info['site']} as {C['b']}{info['username']}{C['r']}"
                  f"\n  {C['dim']}run  sintfoap  to see your dashboard{C['r']}")
        elif cmd == "logout":
            where = site.logout()
            print(f"  signed out of {where}" if where else "  wasn't signed in")
        elif cmd == "app":
            app_info(site.app_release())
        elif cmd == "whoami":
            me = site.whoami()
            print(f"  {me['username']} ({me['display_name']}) on {me['site']}")
        else:
            if not site.load_login():
                site.login()
            if cmd == "dashboard" and (getattr(args, "plain", False) or not sys.stdout.isatty()):
                plain(site.dashboard())
            elif not sys.stdout.isatty():
                sys.exit(f"sintfoap {cmd} needs a terminal; try  sintfoap dashboard --plain")
            else:
                from .tui import run
                run(cmd, room=getattr(args, "room", None))
    except site.SiteError as e:
        sys.exit(f"sintfoap: {e}")
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
