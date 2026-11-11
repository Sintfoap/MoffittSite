// Text recognition (Tesseract) reads a two-column cookbook page straight
// across, ingredients and method interleaved line by line. This puts the
// columns back: from the words and where they sit, it finds the gutter, then
// writes the left column, then the right, with full-width lines (the title, a
// tip across the bottom) where they were. It also picks the line in the
// biggest type as the title. Plain data in and out, so the tests can run it.
//
// lines: [{text, bbox: {x0, y0, x1, y1}, words: [{text, bbox}]}], top to bottom.

export function arrange(lines) {
  lines = lines.filter(l => l.words?.length && l.text.trim()).sort((a, b) => a.bbox.y0 - b.bbox.y0);
  if (!lines.length) return { text: "", title: "" };
  const left = Math.min(...lines.map(l => l.bbox.x0)), right = Math.max(...lines.map(l => l.bbox.x1));
  const width = right - left || 1;

  // Lines side by side (one in each column, or one line read as two) as one row.
  const level = [];
  for (const l of lines) {
    const g = level[level.length - 1];
    const h = g && Math.min(l.bbox.y1 - l.bbox.y0, g.bbox.y1 - g.bbox.y0);
    // Only lines that sit beside each other: a tilted photo's long line can
    // reach down beside the short one under it, which is the next row.
    const beside = g && (l.bbox.x0 >= g.bbox.x1 - h || l.bbox.x1 <= g.bbox.x0 + h);
    if (g && beside && Math.min(g.bbox.y1, l.bbox.y1) - Math.max(g.bbox.y0, l.bbox.y0) > h * 0.5) {
      g.words.push(...l.words);
      g.bbox = { x0: Math.min(g.bbox.x0, l.bbox.x0), y0: Math.min(g.bbox.y0, l.bbox.y0), x1: Math.max(g.bbox.x1, l.bbox.x1), y1: Math.max(g.bbox.y1, l.bbox.y1) };
    } else level.push({ bbox: { ...l.bbox }, words: [...l.words] });
  }

  // Each row cut into pieces wherever the words have a wide gap between them.
  const rows = level.map(l => {
    const words = [...l.words].sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const chars = words.reduce((n, w) => n + w.text.length, 0) || 1;
    const charW = words.reduce((n, w) => n + (w.bbox.x1 - w.bbox.x0), 0) / chars;
    const gapMin = Math.max(charW * 3.5, width * 0.03);
    const pieces = [];
    for (const w of words) {
      const last = pieces[pieces.length - 1];
      if (last && w.bbox.x0 - last.x1 <= gapMin) { last.words.push(w.text); last.x1 = w.bbox.x1; }
      else pieces.push({ words: [w.text], x0: w.bbox.x0, x1: w.bbox.x1 });
    }
    return { y0: l.bbox.y0, y1: l.bbox.y1, pieces: pieces.map(p => ({ text: p.words.join(" "), x0: p.x0, x1: p.x1 })) };
  });

  // The gutter: the middle of the widest gap, in the lines that have one.
  const gaps = rows.filter(r => r.pieces.length >= 2).map(r => {
    let best = null;
    for (let i = 1; i < r.pieces.length; i++) {
      const g = { at: (r.pieces[i - 1].x1 + r.pieces[i].x0) / 2, size: r.pieces[i].x0 - r.pieces[i - 1].x1 };
      if (!best || g.size > best.size) best = g;
    }
    return best.at;
  }).sort((a, b) => a - b);
  const title = biggest(lines);
  // Or, when the lines came already cut at the columns (so none has a gap), the
  // clearest place down the page that the fewest lines cross.
  const gutter = gaps.length >= 2 ? gaps[Math.floor(gaps.length / 2)] : between(rows, left, width);
  if (gutter == null) return { text: plain(rows), title };

  // Lines that cross the gutter are full width; runs of the others are columns.
  const out = [];
  let colL = [], colR = [], lastL = null, lastR = null;
  const height = rows.map(r => r.y1 - r.y0).sort((a, b) => a - b)[Math.floor(rows.length / 2)] || 1;
  const push = (col, last, text, row) => {
    if (last && row.y0 - last.y1 > height * 0.9) col.push({ text: "" });
    col.push({ text, row });
  };
  // A paragraph at the foot of one column that starts below the end of the
  // other (a tip under the ingredients) comes after both.
  const tail = (col, other) => {
    const end = Math.max(...other.filter(x => x.row).map(x => x.row.y1));
    const at = col.findLastIndex(x => !x.row);
    return at >= 0 && other.length && col[at + 1]?.row.y0 > end ? col.splice(at) : [];
  };
  const flush = () => {
    const after = [...tail(colL, colR), ...tail(colR, colL)];
    if (colL.length || colR.length) out.push(...[...colL, { text: "" }, ...colR, { text: "" }, ...after].map(x => x.text), "");
    colL = []; colR = []; lastL = lastR = null;
  };
  for (const r of rows) {
    const crosses = r.pieces.some(p => p.x0 < gutter && p.x1 > gutter);
    if (crosses) { flush(); out.push(r.pieces.map(p => p.text).join(" ")); continue; }
    const l = r.pieces.filter(p => p.x1 <= gutter).map(p => p.text).join(" ");
    const rt = r.pieces.filter(p => p.x0 >= gutter).map(p => p.text).join(" ");
    if (l) { push(colL, lastL, l, r); lastL = r; }
    if (rt) { push(colR, lastR, rt, r); lastR = r; }
  }
  flush();
  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(), title };
}

// The x down the middle of the page with the fewest pieces across it and at
// least three wholly on each side, or null if the page isn't in columns.
function between(rows, left, width) {
  const pieces = rows.flatMap(r => r.pieces);
  let best = null, run = null;
  for (let i = 0; i <= 120; i++) {
    const x = left + width * (0.2 + 0.6 * i / 120);
    let across = 0, l = 0, r = 0;
    for (const p of pieces) {
      if (p.x1 <= x) l++; else if (p.x0 >= x) r++; else across++;
    }
    const ok = l >= 3 && r >= 3 && across <= rows.length * 0.4;
    if (ok && run && run.across === across) run.to = x;
    else run = ok ? { across, from: x, to: x } : null;
    if (run && (!best || run.across < best.across || (run.across === best.across && run.to - run.from > best.to - best.from))) best = { ...run };
  }
  return best && (best.from + best.to) / 2;
}

// Lines as they are, with a blank line at each bigger gap.
function plain(rows) {
  const height = rows.map(r => r.y1 - r.y0).sort((a, b) => a - b)[Math.floor(rows.length / 2)] || 1;
  return rows.map((r, i) => (i && r.y0 - rows[i - 1].y1 > height * 0.9 ? "\n" : "") + r.pieces.map(p => p.text).join(" ")).join("\n");
}

// The line in the biggest type (by the height of its lower-case-free words, near enough).
function biggest(lines) {
  let best = "", tallest = 0;
  for (const l of lines) {
    const t = l.text.trim(), h = l.bbox.y1 - l.bbox.y0;
    if (/\p{L}{3}/u.test(t) && t.length <= 80 && (l.confidence ?? 100) > 50 && h > tallest * 1.05) { tallest = h; best = t; }
  }
  return best;
}
