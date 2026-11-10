Text recognition for Recipe box's "From a photo", run in the browser so a photo
never leaves the device and no key is needed. Vendored unmodified from npm
(Apache-2.0, see LICENSE):

- tesseract.min.js, worker.min.js: tesseract.js 7.0.0
- tesseract-core-{,simd-,relaxedsimd-}lstm.wasm.js: tesseract.js-core 7.0.0
  (the worker picks the one the browser supports)
- eng.traineddata.gz: @tesseract.js-data/eng 1.0.0, 4.0.0_best_int

The page loads these only when a photo is read, and the browser keeps the
language data afterwards. public/recipes/app.js runs it; columns.js and read.js
turn what it reads into a recipe.
