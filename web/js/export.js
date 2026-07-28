async function pipe(uint8, stream) {
  const out = new Response(
    new Blob([uint8]).stream().pipeThrough(stream),
  );
  return new Uint8Array(await out.arrayBuffer());
}

export const supportsCompression = () => typeof CompressionStream !== "undefined";
export const gzip = (u8) => pipe(u8, new CompressionStream("gzip"));
export const gunzip = (u8) => pipe(u8, new DecompressionStream("gzip"));

export function downloadBlob(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the in-progress download in Safari/Firefox.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
