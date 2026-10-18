// Rich text in chat messages: a little Markdown, the kind people type anyway.
//   **bold**  *italic* or _italic_  ~~struck~~  `code`  ```a code block```
//   > a quote (at the start of a line)   [words](https://a.link)
// A message's body is kept as that text, so every room, the terminal and
// search see the same thing. Matrix sends formatting as HTML
// (formatted_body), which is turned into this on the way in and made from it
// on the way out, as Element does. Used by the chat page and, for Matrix, by
// the Worker (src/matrix.js), so it needs no DOM.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ESC[c]);
const URL_RE = /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)"'\]]/g;

// Inline formatting of one line or run of text that isn't code: escaped first,
// then marked up. link(url, text) and mention(name) say how links and
// @names come out (for the chat page); left out, as Matrix wants them.
function inline(text, { link = (u, t) => (t === u ? u : `<a href="${u}">${t}</a>`), mention } = {}) {
  const links = [];
  // Links first, out of the way of the rest (a URL can hold _ and *).
  let s = text.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `\u0000${links.push([u, t]) - 1}\u0000`);
  s = s.replace(URL_RE, u => `\u0000${links.push([u, u]) - 1}\u0000`);
  s = esc(s)
    .replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?![\w*])/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([^~]*?\S)~~/g, "<del>$1</del>");
  if (mention) s = s.replace(/(^|[^\w@.\/])@([a-z0-9][a-z0-9_-]{2,31})(?![\w-])/gi, (all, pre, name) => pre + mention(name));
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => { const [u, t] = links[i]; return link(esc(u), t === u ? esc(u) : inline(t, { link: (_, x) => x })); });
}

// Body text → HTML: code kept as it is, quotes, line breaks (opts.newline:
// what a line break becomes; <br> for Matrix, "\n" where white space shows).
export function toHtml(body, opts = {}) {
  const br = opts.newline ?? "<br>";
  const out = [];
  const parts = String(body ?? "").split(/```(?:[a-z0-9+-]*\n)?([\s\S]*?)```/i);
  parts.forEach((part, i) => {
    if (i % 2) { out.push(`<pre><code>${esc(part.replace(/\n$/, ""))}</code></pre>`); return; }
    const lines = part.replace(/^\n|\n$/g, i ? "" : "$&").split("\n");
    let quote = [];
    const flush = () => { if (quote.length) out.push(`<blockquote>${quote.join(br)}</blockquote>`); quote = []; };
    const plain = [];
    const flushPlain = () => { if (plain.length) out.push(plain.join(br)); plain.length = 0; };
    for (const line of lines) {
      const q = /^> ?(.*)$/.exec(line);
      const html = (q ? q[1] : line).split(/`([^`\n]+)`/).map((s, j) => j % 2 ? `<code>${esc(s)}</code>` : inline(s, opts)).join("");
      if (q) { flushPlain(); quote.push(html); } else { flush(); plain.push(html); }
    }
    flush(); flushPlain();
  });
  return out.join("");
}

// Whether a body has any formatting at all (so plain text is sent plain).
export const hasFormatting = body => toHtml(body) !== esc(String(body ?? "")).replace(/\n/g, "<br>");

// ── Matrix's HTML → body text ────────────────────────────────────────────
// Only what's above survives; any other tag is dropped and its text kept.
// A reply's quote of what it answers (<mx-reply>) goes entirely.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
  if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ""; }
  return ENTITIES[e.toLowerCase()] ?? all;
});

export function fromHtml(html) {
  let s = String(html ?? "").replace(/<(mx-reply|script|style)\b[\s\S]*?<\/\1\s*>/gi, "");
  const attr = (tag, name) => { const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag); return m ? decode(m[2] ?? m[3]) : ""; };
  const out = [];
  let list = [], pre = 0;
  // Tags and text, in order.
  for (const [, tag, text] of s.matchAll(/(<[^>]*>)|([^<]+)/g)) {
    if (text !== undefined) { out.push(pre ? decode(text) : decode(text).replace(/\s*\n\s*/g, " ")); continue; }
    const m = /^<\s*(\/?)\s*([a-z0-9-]+)/i.exec(tag);
    if (!m) continue;
    const close = !!m[1], name = m[2].toLowerCase();
    switch (name) {
      case "b": case "strong": out.push("**"); break;
      case "i": case "em": out.push("*"); break;
      case "del": case "s": case "strike": out.push("~~"); break;
      case "code": if (!pre) out.push("`"); break;
      case "pre": pre += close ? -1 : 1; out.push(close ? "\n```\n" : "\n```\n"); break;
      case "br": out.push("\n"); break;
      case "p": case "div": out.push("\n"); break;
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": out.push(close ? "**\n" : "\n**"); break;
      case "ul": case "ol": if (close) list.pop(); else list.push(name === "ol" ? 0 : -1); out.push("\n"); break;
      case "li": if (!close) { const top = list.length - 1; out.push("\n" + "  ".repeat(Math.max(0, top)) + (list[top] >= 0 ? `${++list[top]}. ` : "- ")); } break;
      case "blockquote": out.push(close ? "\n\u0002" : "\n\u0001"); break;
      case "a": {
        if (close) { out.push("\u0003"); break; }
        const href = attr(tag, "href");
        out.push(/^https?:\/\//i.test(href) ? `\u0004${href}\u0005` : "\u0006"); break;
      }
      case "img": if (!close) out.push(attr(tag, "alt")); break;
      default: break;
    }
  }
  let text = out.join("");
  // Links: [text](url), or just the url when that's what it says. (A
  // matrix.to mention link comes out as the name it shows.)
  text = text.replace(/\u0004([^\u0005]*)\u0005([^\u0003]*)\u0003/g, (all, href, t) =>
    t.trim() === href || !t.trim() ? href : /^https:\/\/matrix\.to\/#\/[@#]/.test(href) ? t : `[${t}](${href})`)
    .replace(/\u0006([^\u0003]*)\u0003/g, "$1");
  // Quotes: every line inside gets "> ".
  for (let i = 0; i < 5 && text.includes("\u0001"); i++) {
    text = text.replace(/\u0001([^\u0001\u0002]*)\u0002/g, (_, q) => q.trim().split("\n").map(l => "> " + l).join("\n") + "\n");
  }
  return text.replace(/[\u0000-\u0006]/g, "").replace(/\*\*\s*\*\*/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n+```(\n|$)/g, "\n```$1").replace(/\n{3,}/g, "\n\n").trim();
}

// ── Matrix message content ───────────────────────────────────────────────
// Chat's text → a Matrix message: with HTML as well when it has formatting,
// and saying what it answers when it's a reply (reply: its id there).
export function messageContent(text, { reply } = {}) {
  const c = { msgtype: "m.text", body: text };
  if (hasFormatting(text)) Object.assign(c, { format: "org.matrix.custom.html", formatted_body: toHtml(text) });
  if (reply) c["m.relates_to"] = { "m.in_reply_to": { event_id: reply } };
  return c;
}
export function editContent(eventId, text) {
  const { msgtype, body, ...html } = messageContent(text);
  return { msgtype, body: "* " + body, ...(html.format ? { format: html.format, formatted_body: "* " + html.formatted_body } : {}),
    "m.new_content": messageContent(text), "m.relates_to": { rel_type: "m.replace", event_id: eventId } };
}
