// Reads the files out of a .zip in the browser (Recipe Keeper's export is
// one: recipes.html and an images folder). Stored and deflated entries only,
// which is all zips use in practice; deflate goes through DecompressionStream.

export async function unzip(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // The end of central directory record: within the last 64 KB + 22 bytes.
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error("that isn't a zip file this page can read");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const names = new TextDecoder();
  const files = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("that zip file looks damaged");
    const method = view.getUint16(at + 10, true), size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true), extraLen = view.getUint16(at + 30, true), commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = names.decode(buf.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = buf.subarray(start, start + size);
    if (method !== 0 && method !== 8) continue;
    files.push({
      name,
      // Unpacked only when asked for, so a big export isn't all in memory twice.
      blob: () => method === 0 ? Promise.resolve(new Blob([raw])) :
        new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob(),
    });
  }
  return files;
}
