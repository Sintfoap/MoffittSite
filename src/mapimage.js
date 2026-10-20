// A picture of a day's route, as a PNG: OpenStreetMap tiles with the route,
// the numbered stops and the base drawn on top, like Locations' Map view.
// For agents, through the MCP's drift_get_map (src/mcp.js). Made without a
// browser: tiles are decoded, drawn on and encoded here, with the
// runtime's own deflate (CompressionStream).

const TILE = 256, MAX_TILES = 40;
const TILES = "https://tile.openstreetmap.org";
const UA = "MoffittSite-Drift/1.0 (route images; low volume)";
const INK = [26, 18, 6], GOLD = [214, 168, 72], RED = [208, 80, 60], WHITE = [255, 255, 255], PAPER = [236, 231, 218], FAINT = [120, 112, 96];

// ── PNG ────────────────────────────────────────────────────────────────────
const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

async function through(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
const inflate = b => through(b, new DecompressionStream("deflate"));
const deflate = b => through(b, new CompressionStream("deflate"));

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Decodes a PNG to {w, h, rgb} (alpha dropped onto white), or null for one it can't read.
export async function decodePng(buf) {
  const b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 8 || SIG.some((x, i) => b[i] !== x)) return null;
  let w, h, depth, type, interlace, plte = null, trns = null;
  const idat = [];
  for (let p = 8; p + 8 <= b.length;) {
    const len = dv.getUint32(p), kind = String.fromCharCode(...b.subarray(p + 4, p + 8)), data = b.subarray(p + 8, p + 8 + len);
    if (kind === "IHDR") { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === "PLTE") plte = data;
    else if (kind === "tRNS") trns = data;
    else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    p += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!w || !channels || interlace || depth > 8 || (type === 3 && !plte)) return null;
  const all = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  idat.reduce((o, d) => (all.set(d, o), o + d.length), 0);
  let raw;
  try { raw = await inflate(all); } catch { return null; }
  const stride = Math.ceil(w * channels * depth / 8), bpp = Math.max(1, channels * depth / 8);
  if (raw.length < h * (stride + 1)) return null;
  const px = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, up = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp] : 0, b = y ? px[up + x] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const c = x >= bpp && y ? px[up + x - bpp] : 0, p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[row + x] = v;
    }
  }
  const rgb = new Uint8Array(w * h * 3), max = (1 << depth) - 1;
  // The usual cases, quickly: OpenStreetMap's tiles are 8-bit palette or RGB.
  if (depth === 8 && (type === 2 || (type === 3 && !trns))) {
    for (let y = 0, o = 0; y < h; y++) for (let x = 0, p = y * stride; x < w; x++, o += 3) {
      if (type === 2) { rgb[o] = px[p++]; rgb[o + 1] = px[p++]; rgb[o + 2] = px[p++]; }
      else { const i = px[p++] * 3; rgb[o] = plte[i]; rgb[o + 1] = plte[i + 1]; rgb[o + 2] = plte[i + 2]; }
    }
    return { w, h, rgb };
  }
  const sample = (row, i) => depth === 8 ? px[row + i] : (px[row + ((i * depth) >> 3)] >> (8 - depth - ((i * depth) & 7))) & max;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const row = y * stride, o = (y * w + x) * 3;
    let r, g, bl, al = 255;
    if (type === 3) { const i = sample(row, x); [r, g, bl] = [plte[i * 3], plte[i * 3 + 1], plte[i * 3 + 2]]; if (trns && i < trns.length) al = trns[i]; }
    else if (type === 0 || type === 4) { const v = Math.round(sample(row, x * channels) * 255 / max); r = g = bl = v; if (type === 4) al = px[row + x * 2 + 1]; }
    else { r = px[row + x * channels]; g = px[row + x * channels + 1]; bl = px[row + x * channels + 2]; if (type === 6) al = px[row + x * 4 + 3]; }
    rgb[o] = (r * al + 255 * (255 - al)) / 255; rgb[o + 1] = (g * al + 255 * (255 - al)) / 255; rgb[o + 2] = (bl * al + 255 * (255 - al)) / 255;
  }
  return { w, h, rgb };
}

export async function encodePng(w, h, rgb) {
  const raw = new Uint8Array(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  const chunk = (kind, data) => {
    const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set([...kind].map(c => c.charCodeAt(0)), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array(SIG), chunk("IHDR", ihdr), chunk("IDAT", await deflate(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((o, p) => (out.set(p, o), o + p.length), 0);
  return out;
}

// ── drawing ────────────────────────────────────────────────────────────────
// A 5×7 font for labels: digits, capitals and a little punctuation.
const FONT = {
  "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14], "2": [14, 17, 1, 2, 4, 8, 31], "3": [31, 2, 4, 2, 1, 17, 14],
  "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 30, 1, 1, 17, 14], "6": [6, 8, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14], "9": [14, 17, 17, 15, 1, 2, 12],
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [28, 18, 17, 17, 17, 18, 28],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  " ": [0, 0, 0, 0, 0, 0, 0], ".": [0, 0, 0, 0, 0, 12, 12], ",": [0, 0, 0, 0, 12, 4, 8], "(": [2, 4, 8, 8, 8, 4, 2], ")": [8, 4, 2, 2, 2, 4, 8],
  "-": [0, 0, 0, 31, 0, 0, 0], ":": [0, 12, 12, 0, 12, 12, 0], "/": [1, 2, 2, 4, 8, 8, 16], "+": [0, 4, 4, 31, 4, 4, 0], "·": [0, 0, 0, 12, 12, 0, 0],
  "'": [4, 4, 8, 0, 0, 0, 0], "&": [12, 18, 20, 8, 21, 18, 13],
};
const plain = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[‘’]/g, "'").replace(/[–—]/g, "-").toUpperCase();

class Canvas {
  constructor(w, h) {
    this.w = w; this.h = h; this.rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < this.rgb.length; i += 3) { this.rgb[i] = PAPER[0]; this.rgb[i + 1] = PAPER[1]; this.rgb[i + 2] = PAPER[2]; }
  }
  set(x, y, c, a = 1) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 3;
    if (a >= 1) this.rgb.set(c, o);
    else for (let k = 0; k < 3; k++) this.rgb[o + k] = this.rgb[o + k] * (1 - a) + c[k] * a;
  }
  disc(cx, cy, r, c) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r + 0.5) this.set(x, y, c, Math.min(1, r + 0.5 - d));
    }
  }
  rect(x0, y0, w, h, c, a = 1) { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, c, a); }
  // A thick line along pts, solid or dashed every `dash` pixels: each pixel
  // takes its nearest distance to the line, so joins and overlaps blend once.
  line(pts, r, c, dash = 0) {
    const cover = new Float32Array(this.w * this.h), reach = (r + 0.5) ** 2;
    let run = 0, lo = cover.length, hi = 0;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy, len = Math.sqrt(len2);
      const xa = Math.max(0, Math.floor(Math.min(x0, x1) - r - 1)), xb = Math.min(this.w - 1, Math.ceil(Math.max(x0, x1) + r + 1));
      const ya = Math.max(0, Math.floor(Math.min(y0, y1) - r - 1)), yb = Math.min(this.h - 1, Math.ceil(Math.max(y0, y1) + r + 1));
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
        const t = len2 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / len2)) : 0;
        const ex = x - x0 - t * dx, ey = y - y0 - t * dy, d2 = ex * ex + ey * ey;
        if (d2 >= reach || (dash && (run + t * len) % (dash * 2) >= dash)) continue;
        const a = Math.min(1, r + 0.5 - Math.sqrt(d2)), o = y * this.w + x;
        if (a > cover[o]) { cover[o] = a; if (o < lo) lo = o; if (o > hi) hi = o; }
      }
      run += len;
    }
    for (let o = lo; o <= hi; o++) if (cover[o] > 0) this.set(o % this.w, Math.floor(o / this.w), c, cover[o]);
  }
  text(s, x, y, c, scale = 1) {
    for (const ch of plain(s)) {
      const g = FONT[ch] || FONT[" "];
      for (let r = 0; r < 7; r++) for (let col = 0; col < 5; col++) if (g[r] & (16 >> col)) this.rect(x + col * scale, y + r * scale, scale, scale, c);
      x += 6 * scale;
    }
    return x;
  }
  textWidth(s, scale = 1) { return [...plain(s)].length * 6 * scale - scale; }
  tile(img, ox, oy) {
    const x0 = Math.max(0, ox), x1 = Math.min(this.w, ox + img.w);
    if (x1 <= x0) return;
    for (let y = Math.max(0, oy); y < Math.min(this.h, oy + img.h); y++)
      this.rgb.set(img.rgb.subarray(((y - oy) * img.w + x0 - ox) * 3, ((y - oy) * img.w + x1 - ox) * 3), (y * this.w + x0) * 3);
  }
  // Fades everything toward colour c.
  wash(c, a) { for (let i = 0; i < this.rgb.length; i++) this.rgb[i] += (c[i % 3] - this.rgb[i]) * a; }
}

// Web Mercator: world pixels at zoom z.
const worldX = (lng, z) => (lng + 180) / 360 * TILE * 2 ** z;
const worldY = (lat, z) => { const s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z; };

async function fetchTile(z, x, y) {
  const n = 2 ** z, url = `${TILES}/${z}/${((x % n) + n) % n}/${y}.png`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, cf: { cacheTtl: 604800, cacheEverything: true }, signal: AbortSignal.timeout(6000) });
    return res.ok ? decodePng(await res.arrayBuffer()) : null;
  } catch { return null; }
}

export const stopLabel = n => n < 10 ? String(n) : n < 36 ? String.fromCharCode(55 + n) : "+";

// The PNG for a plan from src/routing.js's planDay (with each stop's lat and lng).
// `title` is drawn across the top.
export async function routeImage(plan, { width = 800, height = 600, title = "" } = {}) {
  const W = Math.max(320, Math.min(1280, Math.round(width))), H = Math.max(240, Math.min(1280, Math.round(height)));
  const c = new Canvas(W, H), top = 30, pad = 44;
  const opt = plan.options?.[plan.option];
  const byId = new Map(plan.stops.map(s => [s.id, s]));
  const order = opt ? opt.order.map(id => byId.get(id)).filter(Boolean) : plan.stops;
  const base = plan.base?.lat != null ? plan.base : null;
  const pts = [...order.map(s => [s.lat, s.lng]), ...(base ? [[base.lat, base.lng]] : []), ...(plan.path || [])];

  if (pts.length) {
    // The closest zoom that fits everything in.
    let z = 17;
    const span = z => {
      const xs = pts.map(p => worldX(p[1], z)), ys = pts.map(p => worldY(p[0], z));
      return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), (Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2];
    };
    while (z > 1) { const [sw, sh] = span(z); if (sw <= W - 2 * pad && sh <= H - top - 2 * pad) break; z--; }
    const [, , mx, my] = span(z), ox = mx - W / 2, oy = my - (H + top) / 2;
    const at = (lat, lng) => [worldX(lng, z) - ox, worldY(lat, z) - oy];

    const tiles = [];
    for (let ty = Math.floor(oy / TILE); ty <= Math.floor((oy + H) / TILE); ty++)
      for (let tx = Math.floor(ox / TILE); tx <= Math.floor((ox + W) / TILE); tx++)
        if (ty >= 0 && ty < 2 ** z && tiles.length < MAX_TILES) tiles.push([tx, ty]);
    const imgs = await Promise.all(tiles.map(([tx, ty]) => fetchTile(z, tx, ty)));
    imgs.forEach((img, i) => { if (img) c.tile(img, Math.round(tiles[i][0] * TILE - ox), Math.round(tiles[i][1] * TILE - oy)); });
    if (imgs.some(Boolean)) c.wash(WHITE, 0.15);              // soften the map under the route

    const line = plan.path?.length > 1 ? plan.path.map(p => at(p[0], p[1]))
      : [...(base ? [at(base.lat, base.lng)] : []), ...order.map(s => at(s.lat, s.lng)), ...(base ? [at(base.lat, base.lng)] : [])];
    if (line.length > 1) {
      const dash = plan.streets ? 0 : 7;
      c.line(line, 4.5, INK, dash);
      c.line(line, 2.5, GOLD, dash);
    }
    if (base) {
      const [x, y] = at(base.lat, base.lng);
      c.disc(x, y, 13, WHITE); c.disc(x, y, 11, INK);
      // A little house.
      for (let r = 0; r < 6; r++) c.rect(Math.round(x - r), Math.round(y - 6 + r), 2 * r + 1, 1, WHITE);
      c.rect(Math.round(x - 5), Math.round(y), 11, 6, WHITE); c.rect(Math.round(x - 1), Math.round(y + 2), 3, 4, INK);
    }
    const late = new Set(opt?.late || []);
    order.forEach((s, i) => {
      const [x, y] = at(s.lat, s.lng), t = stopLabel(i + 1);
      c.disc(x, y, 13, INK); c.disc(x, y, 11, late.has(s.id) ? RED : GOLD);
      c.text(t, Math.round(x - c.textWidth(t, 2) / 2), Math.round(y - 7), INK, 2);
    });
  } else {
    c.text("NOTHING WITH A PLACE ON THIS DAY", 20, top + 20, FAINT, 2);
  }

  // The title across the top, and OpenStreetMap's credit at the bottom.
  c.rect(0, 0, W, top, INK);
  let t = plain(title);
  while (t && c.textWidth(t, 2) > W - 20) t = t.slice(0, -1);
  c.text(t, 10, 8, WHITE, 2);
  const credit = "(C) OPENSTREETMAP CONTRIBUTORS", cw = c.textWidth(credit);
  c.rect(W - cw - 10, H - 13, cw + 10, 13, WHITE, 0.85);
  c.text(credit, W - cw - 5, H - 10, FAINT);
  return encodePng(W, H, c.rgb);
}
