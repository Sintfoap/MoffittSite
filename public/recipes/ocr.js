// Getting a photo ready for text recognition (Tesseract) on this device, and
// putting right what it misreads most in recipes: the fractions.
//
// sized(photo), then blackAndWhite(canvas): the photo as clean black ink on white. Each pixel is
// compared with the paper around it (Sauvola's threshold, on the darkest of its
// red, green and blue), so ruled lines, coloured ink, shadows and tinted paper
// don't get read as text. A small photo is made bigger first.
//
// fixFractions(canvas, lines): Tesseract's English has no ½ ¼ ¾ ⅓, so it reads
// them as %, ¥, Y2, 14 or a lone 1. The first word of each line that looks
// like one of those is compared, shape for shape, with the fractions drawn in
// a serif and a sans-serif type (and with whole numbers, so a real "1" stays a
// 1), and the closest wins. It changes the lines in place and says how many.

// ── cleaning the photo ─────────────────────────────────────────────────────

const LONG = 2400, SHORTEST = 1600;  // the longer side: at most 2400, at least 1600

// The picture (an ImageBitmap or canvas) at a size Tesseract reads well, on a new canvas.
export function sized(src) {
  const long = Math.max(src.width, src.height);
  const k = long > LONG ? LONG / long : long < SHORTEST ? SHORTEST / long : 1;
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(src.width * k), height: Math.round(src.height * k) });
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";  // a PNG's see-through parts, white rather than black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Black and white, in place. Plain data in and out (an ImageData-like {width, height, data}), so the tests can run it.
export function binarize(img, { window = 40, k = 0.2 } = {}) {
  const { width: W, height: H, data: d } = img;
  const g = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
  // Running sums, so each pixel's neighbourhood mean and spread take four lookups.
  const w1 = W + 1, S = new Float64Array(w1 * (H + 1)), S2 = new Float64Array(w1 * (H + 1));
  for (let y = 0; y < H; y++) {
    let a = 0, b = 0;
    for (let x = 0; x < W; x++) {
      const v = g[y * W + x];
      a += v; b += v * v;
      S[(y + 1) * w1 + x + 1] = S[y * w1 + x + 1] + a;
      S2[(y + 1) * w1 + x + 1] = S2[y * w1 + x + 1] + b;
    }
  }
  const r = Math.max(4, Math.round(Math.max(W, H) / window));
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1), n = (x1 - x0) * (y1 - y0);
      const s = S[y1 * w1 + x1] - S[y0 * w1 + x1] - S[y1 * w1 + x0] + S[y0 * w1 + x0];
      const s2 = S2[y1 * w1 + x1] - S2[y0 * w1 + x1] - S2[y1 * w1 + x0] + S2[y0 * w1 + x0];
      const m = s / n, sd = Math.sqrt(Math.max(0, s2 / n - m * m));
      const v = g[y * W + x] < m * (1 + k * (sd / 128 - 1)) ? 0 : 255, i = (y * W + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
  }
  return img;
}

// A copy of the (sized) photo in black and white, for Tesseract; the photo itself
// stays in colour, to find the dish's picture in.
export function blackAndWhite(src) {
  const canvas = Object.assign(document.createElement("canvas"), { width: src.width, height: src.height });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.putImageData(binarize(src.getContext("2d").getImageData(0, 0, src.width, src.height)), 0, 0);
  return canvas;
}

// ── the fractions ──────────────────────────────────────────────────────────

const FRACTIONS = ["½", "¼", "¾", "⅓", "⅔", "⅛"];
const WHOLE = ["", "1", "2", "3"];
// What Tesseract makes of a fraction, alone or after a whole number.
const SUSPECT = /^\d?(?:[%¥£§®©°¢»«$&@#*]{1,2}|[Yy][a-z0-9]?|[Il|][\/:]?\d|1[2348]|\d\/\d)$/;
const SIZE = 32;  // shapes are compared at this height

// A word's dark pixels, cut tight and scaled to SIZE high: {w, px} or null.
function shape(ctx, box) {
  const pad = 2, x0 = Math.max(0, Math.floor(box.x0) - pad), y0 = Math.max(0, Math.floor(box.y0) - pad);
  const w = Math.min(ctx.canvas.width - x0, Math.ceil(box.x1 - box.x0) + 2 * pad), h = Math.min(ctx.canvas.height - y0, Math.ceil(box.y1 - box.y0) + 2 * pad);
  if (w < 3 || h < 3) return null;
  return tight(ctx.getImageData(x0, y0, w, h));
}

function tight(img) {
  const { width: W, height: H, data: d } = img;
  let a = W, b = H, c = -1, e = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4] < 128) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); e = Math.max(e, y); }
  if (c < 0) return null;
  const cw = c - a + 1, ch = e - b + 1, w = Math.max(1, Math.round(cw * SIZE / ch));
  const px = new Uint8Array(w * SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < w; x++) {
    const sx = a + Math.min(cw - 1, Math.floor((x + 0.5) * cw / w)), sy = b + Math.min(ch - 1, Math.floor((y + 0.5) * ch / SIZE));
    px[y * w + x] = d[(sy * W + sx) * 4] < 128 ? 1 : 0;
  }
  return { w, px };
}

const FONTS = ["serif", "sans-serif"];
let pad = null;  // the canvas candidates are drawn on
// `text` drawn in each of FONTS: [{text, fraction, w, px}].
function draw(text, fraction) {
  pad ||= Object.assign(document.createElement("canvas"), { width: 320, height: 120 }).getContext("2d", { willReadFrequently: true });
  return FONTS.map(font => {
    pad.fillStyle = "#fff"; pad.fillRect(0, 0, pad.canvas.width, pad.canvas.height);
    pad.fillStyle = "#000"; pad.font = `80px ${font}`; pad.textBaseline = "middle";
    pad.fillText(text, 10, 60);
    const s = tight(pad.getImageData(0, 0, pad.canvas.width, pad.canvas.height));
    return s && { text, fraction, ...s };
  }).filter(Boolean);
}
let drawn = null;  // the fractions and whole numbers, drawn once
const candidates = () => drawn ||= WHOLE.flatMap(whole => [...FRACTIONS, ""].filter(f => whole + f).flatMap(f => draw(whole + f, !!f)));

// How alike two shapes are, 0 to 1: their ink, softened so a pixel or two
// off still counts, compared at the word's width (cosine), over the whole
// shape and again over its lower right, where a fraction's bottom number is
// (the 2 of ½, the 8 of ⅛); less for a different width.
function alike(a, b) {
  if (b.w / a.w > 1.6 || a.w / b.w > 1.6) return 0;
  const sa = soft(a), sb = soft(b, a.w);
  const cos = (x0, y0) => {
    let ab = 0, aa = 0, bb = 0;
    for (let y = y0; y < SIZE; y++) for (let x = x0; x < a.w; x++) {
      const p = sa[y * a.w + x], q = sb[y * a.w + x];
      ab += p * q; aa += p * p; bb += q * q;
    }
    return ab / (Math.sqrt(aa * bb) || 1);
  };
  return (cos(0, 0) + cos(Math.floor(a.w / 2), SIZE / 2)) / 2 * (1 - 0.25 * Math.abs(Math.log(a.w / b.w)));
}

// A shape's ink at width w (its own when not given), each pixel spread over its neighbours.
function soft(s, w = s.w) {
  const out = new Float32Array(w * SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < w; x++) {
    let n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const yy = y + dy, xx = Math.floor((x + dx + 0.5) * s.w / w);
      if (yy >= 0 && yy < SIZE && xx >= 0 && xx < s.w) n += s.px[yy * s.w + xx];
    }
    out[y * w + x] = n;
  }
  return out;
}

// The text a word's shape is closest to, among the fractions and whole numbers, or null.
// `read` is what Tesseract made of it: when that's a number ("12"), it's a candidate too.
function closest(sh, read) {
  let best = null, bestWhole = 0;
  for (const c of [...candidates(), ...(/^\d{2,3}$/.test(read) ? draw(read, false) : [])]) {
    const s = alike(sh, c);
    if (!c.fraction) bestWhole = Math.max(bestWhole, s);
    if (!best || s > best.s) best = { s, text: c.text, fraction: c.fraction };
  }
  // A fraction only when it's clearly closer than any whole number.
  return best && best.fraction && best.s > 0.75 && best.s > bestWhole + 0.03 ? best.text : null;
}

// The line's first word, when it may be a misread fraction: a suspect reading,
// or a lone digit drawn wider than a digit is (½ read as "1").
function suspect(line) {
  const w = line.words[0];
  if (!w || !line.words[1]) return false;
  const t = w.text.trim();
  if (SUSPECT.test(t)) return true;
  if (/^\d$/.test(t)) {
    const h = w.bbox.y1 - w.bbox.y0, wide = (w.bbox.x1 - w.bbox.x0) / (h || 1);
    return wide > 0.6 || (w.confidence ?? 100) < 85;
  }
  return false;
}

// Puts the fractions right in the lines (Tesseract's, in this canvas's pixels): how many it changed.
export function fixFractions(canvas, lines) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let n = 0;
  for (const line of lines) {
    if (!line.words?.length || !suspect(line)) continue;
    const w = line.words[0];
    const sh = shape(ctx, w.bbox);
    const got = sh && closest(sh, w.text.trim());
    if (!got || got === w.text) continue;
    line.text = line.text.replace(w.text, got);
    w.text = got;
    n++;
  }
  return n;
}
