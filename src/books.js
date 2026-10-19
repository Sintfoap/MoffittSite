// Book suggestions at /books: a public page (public/books/) where anyone,
// signed in or not, can vote for the book they'd like the book club to read next.
//
//   GET    /books/api        → {books: [{id, title, author, year, blurb, links, votes}], total, mine, name}
//   POST   /books/api/vote   {book, name?} → the same, after voting (or changing your vote)
//   DELETE /books/api/vote   → the same, after taking your vote back
//
// A browser can't tell a website its computer's name, so a vote is tied to a
// random id in a cookie (__Host-bv): one vote per browser, which it can change.
// With it the site keeps what it can see: the name the voter typed (optional),
// their account if they're signed in, their IP address, the browser and system
// from the User-Agent (the terminal's includes its computer's name), roughly
// where they are (Cloudflare's guess) and when. Admins see all of that on
// /admin, and through GET /admin/api/books for the terminal.

import { db, now } from "./db.js";
import { randomBytes, hex } from "./crypto.js";
import { clientIp, currentSession, readCookie } from "./auth.js";
import { sameOrigin } from "./account.js";

const COOKIE = "__Host-bv";
const VOTER = /^[0-9a-f]{32}$/;
const YEAR = 365 * 86400;
const NEW_VOTERS_PER_IP = 10;    // new votes one address can cast in a day; changing a vote doesn't count

const q = s => encodeURIComponent(s);
const shops = (search, extra = []) => [
  ...extra,
  { label: "Bookshop.org", url: `https://bookshop.org/search?keywords=${q(search)}` },
  { label: "Amazon", url: `https://www.amazon.com/s?k=${q(search)}&i=stripbooks` },
  { label: "Find it at a library", url: `https://search.worldcat.org/search?q=${q(search)}` },
];

// The books on the page, in order. A book's id is what votes are stored under,
// so keep it the same if the rest changes.
export const BOOKS = [
  {
    id: "gods-and-legionnaires",
    title: "Gods & Legionnaires",
    author: "Jason Anspach and Nick Cole",
    year: 2020,
    blurb: "Humanity is losing a war against the Savages, post-human warlords who have remade themselves into something they believe are gods, and the book spends much of its time inside their heads. You see the fighting through the eyes of Savage marines who regard the humans they hunt as lesser beings, then through the eyes of the people desperately holding the line against them. Sliding between those conflicting points of view, the same battles read as glory or as horror depending on who is telling them, and the lyrical prose dwells on both.",
    links: shops("Gods & Legionnaires Anspach Cole", [
      { label: "Audible", url: "https://www.audible.com/pd/B084MLYMCZ" },
    ]),
  },
  {
    id: "the-book-thief",
    title: "The Book Thief",
    author: "Markus Zusak",
    year: 2005,
    blurb: "Nazi Germany, 1939, narrated by Death. Liesel Meminger, a foster girl outside Munich, steals her first book at her brother's graveside and learns to read it with her foster father. As the bombs begin to fall she keeps stealing books, shares them with her neighbours and with the Jewish man hidden in the basement, and finds out what words can do.",
    links: shops("The Book Thief Markus Zusak", [
      { label: "Penguin Random House", url: "https://www.penguinrandomhouse.com/books/196153/the-book-thief-by-markus-zusak/9780375842207" },
    ]),
  },
  {
    id: "the-phantom-of-the-opera",
    title: "The Phantom of the Opera",
    author: "Gaston Leroux",
    year: 1910,
    blurb: "Under the Paris Opéra lives a masked, disfigured genius who haunts the house, writes threats to its managers and secretly tutors the young soprano Christine Daaé. When her childhood sweetheart Raoul comes back into her life, the Phantom's devotion turns dangerous. A Gothic mystery, and the novel behind the musical. It's in the public domain, so it's free to read online.",
    links: shops("The Phantom of the Opera Gaston Leroux", [
      { label: "Free at Project Gutenberg", url: "https://www.gutenberg.org/ebooks/175" },
    ]),
  },
  {
    id: "the-socrates-express",
    title: "The Socrates Express",
    series: "In Search of Life Lessons from Dead Philosophers",
    author: "Eric Weiner",
    year: 2020,
    blurb: "Eric Weiner (The Geography of Bliss) rides trains around the world, from Athens and Delhi to Wyoming, Coney Island and Frankfurt, and on each stop learns one lesson from a philosopher: how to wonder from Socrates, how to walk from Rousseau, how to pay attention from Simone Weil, how to grow old from Beauvoir. Fourteen thinkers, from Marcus Aurelius and Confucius to Nietzsche, as a funny and practical guide to living.",
    links: shops("The Socrates Express Eric Weiner", [
      { label: "Simon & Schuster", url: "https://www.simonandschuster.com/books/The-Socrates-Express/Eric-Weiner/9781501129018" },
    ]),
  },
];

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

// "Chrome on Android" or "sintfoap terminal on ryans-laptop", from the User-Agent.
export function deviceLabel(ua = "") {
  const cli = ua.match(/^sintfoap-cli\/\S+ \((.*)\)$/);
  if (cli) return cli[1] ? `sintfoap terminal on ${cli[1]}` : "sintfoap terminal";
  const browser = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Firefox\//.test(ua) ? "Firefox"
    : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : ua ? "Another browser" : "Unknown browser";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows"
    : /Mac OS X/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

// "Austin, Texas, US" from what Cloudflare knows about the address.
const placeOf = request => {
  const cf = request.cf || {};
  return [cf.city, cf.region, cf.country].filter(Boolean).join(", ");
};

const cleanName = raw => String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60);

async function tallies(d, voter) {
  const { results } = await d.prepare("SELECT book, COUNT(*) AS n FROM book_votes GROUP BY book").all();
  const counts = Object.fromEntries(results.map(r => [r.book, r.n]));
  const mine = voter ? await d.prepare("SELECT book, name FROM book_votes WHERE voter = ?").bind(voter).first() : null;
  return {
    books: BOOKS.map(b => ({ ...b, votes: counts[b.id] || 0 })),
    total: BOOKS.reduce((n, b) => n + (counts[b.id] || 0), 0),
    mine: mine?.book ?? null,
    name: mine?.name ?? "",
  };
}

export async function books(request, env) {
  const { pathname } = new URL(request.url), method = request.method;
  try {
    const d = await db(env);
    let voter = readCookie(request, COOKIE);
    if (voter && !VOTER.test(voter)) voter = null;
    if (pathname === "/books/api" || pathname === "/books/api/") {
      return method === "GET" ? json(await tallies(d, voter)) : json({ error: "method not allowed" }, 405);
    }
    if (pathname !== "/books/api/vote") return json({ error: "not found" }, 404);
    if (method !== "POST" && method !== "DELETE") return json({ error: "method not allowed" }, 405);
    // Votes sent from another website are refused, as forms elsewhere on the site are.
    if (!sameOrigin(request)) return json({ error: "cross-origin request refused" }, 403);

    if (method === "DELETE") {
      if (voter) await d.prepare("DELETE FROM book_votes WHERE voter = ?").bind(voter).run();
      return json(await tallies(d, voter));
    }

    const text = await request.text();
    if (text.length > 2048) return json({ error: "request too large" }, 413);
    let body;
    try { body = JSON.parse(text || "{}"); } catch { return json({ error: "send JSON" }, 400); }
    const book = BOOKS.find(b => b.id === String(body?.book ?? ""));
    if (!book) return json({ error: "that book isn't on the list" }, 400);

    const t = now(), ip = clientIp(request), ua = String(request.headers.get("User-Agent") || "").slice(0, 300);
    let session = null;
    try { session = await currentSession(env, request); } catch { /* voting works signed out */ }
    const existing = voter ? await d.prepare("SELECT 1 AS x FROM book_votes WHERE voter = ?").bind(voter).first() : null;
    if (!existing) {
      const { n } = await d.prepare("SELECT COUNT(*) AS n FROM book_votes WHERE ip = ? AND created_at > ?").bind(ip, t - 86400).first();
      if (n >= NEW_VOTERS_PER_IP) return json({ error: "Too many new votes from your network today. Try again tomorrow." }, 429);
    }
    const headers = {};
    if (!voter) {
      voter = hex(randomBytes(16));
      headers["Set-Cookie"] = `${COOKIE}=${voter}; Path=/; Max-Age=${YEAR}; HttpOnly; Secure; SameSite=Lax`;
    }
    await d.prepare(`INSERT INTO book_votes (voter, book, name, user_id, ip, user_agent, place, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (voter) DO UPDATE SET book = excluded.book, name = excluded.name, user_id = COALESCE(excluded.user_id, user_id),
        ip = excluded.ip, user_agent = excluded.user_agent, place = excluded.place, updated_at = excluded.updated_at`)
      .bind(voter, book.id, cleanName(body.name), session?.user.id ?? null, ip, ua, placeOf(request), t, t).run();
    return json(await tallies(d, voter), 200, headers);
  } catch (e) {
    console.error("books api error:", e);
    return json({ error: "server error" }, 500);
  }
}

// Every vote with who cast it, newest first, for admins (src/account.js).
export async function bookVotes(d) {
  const { results } = await d.prepare(`
    SELECT v.voter, v.book, v.name, v.ip, v.user_agent, v.place, v.created_at, v.updated_at, u.username
    FROM book_votes v LEFT JOIN users u ON u.id = v.user_id ORDER BY v.updated_at DESC`).all();
  const titles = Object.fromEntries(BOOKS.map(b => [b.id, b.title]));
  return results.map(v => ({
    voter: v.voter, book: v.book, title: titles[v.book] || v.book, name: v.name, username: v.username || null,
    ip: v.ip, device: deviceLabel(v.user_agent), user_agent: v.user_agent, place: v.place,
    created_at: v.created_at, updated_at: v.updated_at,
  }));
}

export const removeBookVote = (d, voter) => d.prepare("DELETE FROM book_votes WHERE voter = ?").bind(String(voter)).run();
