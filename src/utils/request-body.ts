// Reads a request body as UTF-8 text, like Request.text(), or returns null once
// it is known to be larger than maxBytes: at once when Content-Length says so,
// otherwise (e.g. a chunked body, which has none, or one whose Content-Length
// understates it) as soon as the bytes read pass the cap. Either way the rest
// of the body is cancelled, not read. The cap counts the bytes the runtime
// hands over, so a compressed body is bounded whether or not it is decoded.
export async function readRequestBodyCapped(req: Request, maxBytes: number): Promise<string | null> {
  if (Number(req.headers.get('Content-Length')) > maxBytes) {
    req.body?.cancel().catch(() => {});
    return null;
  }
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
