"""The terminal's book suggestions page, against the site's real Worker (tests/devsite.mjs)."""
import asyncio
import os

import pytest

from sintfoap import site

pytest.importorskip("textual")
from sintfoap.__main__ import plain_books  # noqa: E402
from sintfoap.books_page import BooksApp, BookCard, Links  # noqa: E402
from sintfoap.tui import SiteApp  # noqa: E402

from test_pages import SHOTS, settle, start_site, type_  # noqa: E402


@pytest.fixture
def public_site(monkeypatch):
    """The site with this terminal signed out: the books page needs no account."""
    proc, origin = start_site(monkeypatch)
    site.forget_login()
    monkeypatch.setenv("SINTFOAP_SITE", origin)
    yield origin
    proc.kill()


@pytest.fixture
def admin_site(monkeypatch):
    proc, origin = start_site(monkeypatch, "--admin")
    yield origin
    proc.kill()


def run_books(app, test, size=(120, 50)):
    async def go():
        async with app.run_test(size=size) as pilot:
            await settle(pilot, 0.5)
            await test(app, pilot)
            if SHOTS:
                app.save_screenshot(f"books-{test.__name__}.svg", SHOTS)
    asyncio.run(go())


def test_anyone_can_read_and_vote_without_signing_in(public_site):
    assert site.load_login() is None

    async def vote(app, pilot):
        page = app.screen
        cards = list(page.query(BookCard))
        assert [c.book["title"] for c in cards] == ["Gods & Legionnaires", "The Book Thief", "The Phantom of the Opera", "The Socrates Express"]
        assert app.focused is cards[0]
        assert not page.query_one("#votes").has_class("on"), "only admins see who voted"
        await pilot.press("n")
        await type_(pilot, "Kim")
        await pilot.press("enter")
        await settle(pilot)
        await pilot.press("down", "enter")
        await settle(pilot)
        assert page.data["mine"] == "the-book-thief"
        assert page.query_one("#book-the-book-thief", BookCard).mine
        await pilot.press("down", "down", "v")        # move the vote
        await settle(pilot)
        assert page.data["mine"] == "the-socrates-express"
        assert page.data["total"] == 1
        await pilot.press("o")
        await settle(pilot, 0.1)
        assert isinstance(app.screen, Links)
        await pilot.press("escape")
    run_books(BooksApp(), vote)

    again = site.books()
    assert again["mine"] == "the-socrates-express" and again["name"] == "Kim", "the terminal keeps its vote"
    assert site.book_unvote()["mine"] is None


def test_plain_lists_the_books_and_their_links(public_site, capsys):
    site.book_vote("the-phantom-of-the-opera")
    plain_books(site.books())
    out = capsys.readouterr().out
    assert "The Phantom of the Opera" in out and "✓ your vote" in out
    assert "https://www.gutenberg.org/ebooks/175" in out
    assert "1 vote so far" in out


def test_admins_see_who_voted_and_can_remove_a_vote(admin_site):
    site.book_vote("gods-and-legionnaires", "Ryan")

    async def votes(app, pilot):
        page = app.screen
        assert page.query_one("#votes").has_class("on")
        assert len(page.votes["votes"]) == 1
        v = page.votes["votes"][0]
        assert v["name"] == "Ryan" and v["username"] == "ryan"
        assert v["device"] == f"sintfoap terminal on {os.uname().nodename[:40]}"
        page.query_one("#voters").focus()
        await pilot.press("x")
        await settle(pilot, 0.1)
        await pilot.press("y")
        await settle(pilot)
        assert page.votes["votes"] == []
        assert page.data["total"] == 0
    run_books(SiteApp("books"), votes)
