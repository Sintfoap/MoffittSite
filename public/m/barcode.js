// The camera, reading groceries' barcodes (EAN-13, EAN-8, UPC-A, UPC-E) for
// Pantry's scanner (pantry.js). The browser's own BarcodeDetector where there
// is one (Chrome on Android); elsewhere (Safari on iPhone) ZXing, from
// vendor/zxing.mjs, loaded the first time it's needed. Either way nothing
// leaves the phone but the digits.

let zx = null;   // the ZXing reader, once loaded

// The camera's picture in `video`, read a few times a second; found(code) for each barcode seen.
// → stop(). Throws when there's no camera, or it isn't allowed (its message says what to do).
export async function startReading(video, found) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't use the camera here. Open the site over https, in Safari or Chrome.");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } });
  } catch (e) {
    throw new Error(e?.name === "NotAllowedError"
      ? "The camera isn't allowed. Allow it for this site in the browser's settings (on an iPhone: Settings → Safari → Camera), then try again."
      : e?.name === "NotFoundError" ? "This device has no camera." : `The camera wouldn't start (${e?.message || e}).`);
  }
  Object.assign(video, { srcObject: stream, muted: true, playsInline: true });
  video.setAttribute("playsinline", "");
  await video.play().catch(() => {});
  const read = await reader();
  let on = true, timer;
  const tick = async () => {
    if (!on) return;
    if (video.readyState >= 2 && video.videoWidth) {
      try { const code = await read(video); if (code && on) found(code); } catch { /* a frame it couldn't read */ }
    }
    if (on) timer = setTimeout(tick, 120);
  };
  tick();
  return () => { on = false; clearTimeout(timer); stream.getTracks().forEach(t => t.stop()); video.srcObject = null; };
}

async function reader() {
  const formats = ["ean_13", "ean_8", "upc_a", "upc_e"];
  if ("BarcodeDetector" in window) {
    try {
      const have = await window.BarcodeDetector.getSupportedFormats();
      if (formats.some(f => have.includes(f))) {
        const d = new window.BarcodeDetector({ formats: formats.filter(f => have.includes(f)) });
        return async video => (await d.detect(video))[0]?.rawValue || null;
      }
    } catch { /* fall back to ZXing */ }
  }
  zx ||= await import("./vendor/zxing.mjs");
  return readWithZxing(zx);
}

// ZXing on a frame: the middle band of the picture, where the aiming line is, in grey.
export function readWithZxing(Z) {
  const hints = new Map([[Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E]],
    [Z.DecodeHintType.TRY_HARDER, true]]);
  const one = new Z.MultiFormatOneDReader(hints);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return video => {
    const vw = video.videoWidth, vh = video.videoHeight;
    // A band across the middle, at most 960 px wide: enough for a barcode filling a third of the picture.
    const sw = vw, sh = Math.round(vh * 0.4), k = Math.min(1, 960 / sw);
    canvas.width = Math.round(sw * k); canvas.height = Math.round(sh * k);
    ctx.drawImage(video, 0, Math.round((vh - sh) / 2), sw, sh, 0, 0, canvas.width, canvas.height);
    return decodePixels(Z, one, hints, ctx.getImageData(0, 0, canvas.width, canvas.height));
  };
}

// RGBA pixels → the barcode's digits, or null.
export function decodePixels(Z, one, hints, { data, width, height }) {
  const grey = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; i < grey.length; i++, j += 4) grey[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
  try {
    return one.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.RGBLuminanceSource(grey, width, height))), hints).getText();
  } catch { return null; } finally { one.reset?.(); }
}
