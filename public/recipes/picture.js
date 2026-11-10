// Where the dish's photo is on a photographed cookbook page, if it has one:
// the biggest patch that is neither paper nor text. The page is looked at in
// small cells; a cell is picture when it's colourful, or textured and away
// from the paper's shade, and no recognized text line covers it. Plain data in
// and out, so the tests (and the terminal's copy, cli/sintfoap/recipe_rules.py)
// can run it.
//
// img: {width, height, data} (RGBA bytes, as canvas ImageData gives), best
// about 200 across. text: [{x0, y0, x1, y1}], the text lines, in img's pixels.
// Returns {x0, y0, x1, y1} as fractions of the width and height, or null.

const CELL = 4;

export function findPicture(img, text = []) {
  const { width: W, height: H, data } = img;
  const cols = Math.floor(W / CELL), rows = Math.floor(H / CELL);
  if (cols < 8 || rows < 8) return null;
  const n = cols * rows;
  const lum = new Float32Array(n), dev = new Float32Array(n), sat = new Float32Array(n);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let s = 0, s2 = 0, st = 0;
    for (let y = r * CELL; y < (r + 1) * CELL; y++) for (let x = c * CELL; x < (c + 1) * CELL; x++) {
      const i = (y * W + x) * 4, R = data[i], G = data[i + 1], B = data[i + 2];
      const l = 0.299 * R + 0.587 * G + 0.114 * B, hi = Math.max(R, G, B);
      s += l; s2 += l * l; st += hi ? (hi - Math.min(R, G, B)) / hi : 0;
    }
    const k = r * cols + c, m = CELL * CELL;
    lum[k] = s / m; dev[k] = Math.sqrt(Math.max(0, s2 / m - (s / m) ** 2)); sat[k] = st / m;
  }
  const paper = [...lum].sort((a, b) => a - b)[Math.floor(n * 0.6)];

  // Text lines, a cell wider all round, aren't picture.
  const words = new Uint8Array(n);
  for (const b of text) {
    const c0 = Math.max(0, Math.floor(b.x0 / CELL) - 1), c1 = Math.min(cols - 1, Math.floor(b.x1 / CELL) + 1);
    const r0 = Math.max(0, Math.floor(b.y0 / CELL) - 1), r1 = Math.min(rows - 1, Math.floor(b.y1 / CELL) + 1);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) words[r * cols + c] = 1;
  }
  const pic = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (words[k]) continue;
    pic[k] = sat[k] > 0.3 || dev[k] > 25 || (Math.abs(lum[k] - paper) > 35 && dev[k] > 6) ? 1 : 0;
  }
  // Close small holes (a plate's white rim, a highlight): a cell between picture cells is picture.
  const filled = pic.slice();
  for (let r = 1; r < rows - 1; r++) for (let c = 1; c < cols - 1; c++) {
    const k = r * cols + c;
    if (!filled[k] && !words[k] && ((pic[k - 1] && pic[k + 1]) || (pic[k - cols] && pic[k + cols]))) filled[k] = 1;
  }

  // The biggest patch of picture cells joined side to side.
  const seen = new Uint8Array(n);
  let best = null;
  for (let k0 = 0; k0 < n; k0++) {
    if (!filled[k0] || seen[k0]) continue;
    const stack = [k0];
    seen[k0] = 1;
    let count = 0, c0 = cols, c1 = 0, r0 = rows, r1 = 0;
    while (stack.length) {
      const k = stack.pop(), r = Math.floor(k / cols), c = k % cols;
      count++;
      if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r;
      for (const j of [c > 0 ? k - 1 : -1, c < cols - 1 ? k + 1 : -1, r > 0 ? k - cols : -1, r < rows - 1 ? k + cols : -1]) {
        if (j >= 0 && filled[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (!best || count > best.count) best = { count, c0, c1, r0, r1 };
  }
  if (!best) return null;
  const w = best.c1 - best.c0 + 1, h = best.r1 - best.r0 + 1;
  // Big enough to be a photo, and mostly filling its box (not a thin border, or the table round the book).
  if (best.count < n * 0.04 || w < cols * 0.15 || h < rows * 0.1 || best.count < w * h * 0.45) return null;
  const f = v => Math.round(v * 1000) / 1000;
  return { x0: f(best.c0 / cols), y0: f(best.r0 / rows), x1: f((best.c1 + 1) / cols), y1: f((best.r1 + 1) / rows) };
}
