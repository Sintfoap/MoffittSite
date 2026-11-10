// Finding the dish's photo on a photographed cookbook page (public/recipes/picture.js).
import test from "node:test";
import assert from "node:assert/strict";
import { findPicture } from "../public/recipes/picture.js";

// A cream page 200×280 with text lines (dark specks) and, if asked, a photo: noisy colour.
function page({ photo = null, shadow = false, lines = 18 } = {}) {
  const W = 200, H = 280, data = new Uint8ClampedArray(W * H * 4), text = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, dim = shadow ? Math.max(0, 60 - x) : 0;
    data[i] = 245 - dim; data[i + 1] = 240 - dim; data[i + 2] = 228 - dim; data[i + 3] = 255;
  }
  const top = photo ? photo.y1 + 8 : 12;
  for (let l = 0; l < lines; l++) {
    const y0 = top + l * 12, box = { x0: 14, y0, x1: 186, y1: y0 + 7 };
    if (box.y1 >= H) break;
    text.push(box);
    for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) if (rnd() < 0.35) {
      const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 30;
    }
  }
  if (photo) for (let y = photo.y0; y < photo.y1; y++) for (let x = photo.x0; x < photo.x1; x++) {
    const i = (y * W + x) * 4;
    data[i] = 120 + rnd() * 120; data[i + 1] = 60 + rnd() * 90; data[i + 2] = 20 + rnd() * 60;
  }
  return [{ width: W, height: H, data }, text];
}

test("the dish's photo above the recipe is found, and its box is close", () => {
  const got = findPicture(...page({ photo: { x0: 20, y0: 10, x1: 180, y1: 120 } }));
  assert.ok(got);
  assert.ok(Math.abs(got.x0 - 0.1) < 0.04 && Math.abs(got.x1 - 0.9) < 0.04, JSON.stringify(got));
  assert.ok(Math.abs(got.y0 - 10 / 280) < 0.04 && Math.abs(got.y1 - 120 / 280) < 0.04, JSON.stringify(got));
});

test("a page of only text has no photo", () => {
  assert.equal(findPicture(...page({ lines: 22 })), null);
});

test("a shadow across the page isn't a photo", () => {
  assert.equal(findPicture(...page({ shadow: true, lines: 22 })), null);
});

test("a small spot (an icon, a stain) isn't a photo", () => {
  assert.equal(findPicture(...page({ photo: { x0: 90, y0: 10, x1: 106, y1: 24 } })), null);
});

test("a picture too small to look at is skipped", () => {
  assert.equal(findPicture({ width: 20, height: 20, data: new Uint8ClampedArray(1600) }), null);
});
