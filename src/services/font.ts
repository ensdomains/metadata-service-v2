// Singleton font loader — fetches Satoshi-Bold from R2, memoizes for isolate lifetime.
//
// Only a finished load is shared. An in-flight load belongs to the request that
// started it: if that request is cancelled (e.g. its client disconnects), its R2
// read never settles, and every other request awaiting the same promise would
// hang with it for the rest of the isolate's life. Until one load has finished,
// each request loads the (small) font itself.

const R2_FONT_KEY = 'fonts/Satoshi-Bold.ttf';

let _base64: string | null = null;
let _buffer: ArrayBuffer | null = null;

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function load(bucket: R2Bucket): Promise<{ buffer: ArrayBuffer; base64: string }> {
  const obj = await bucket.get(R2_FONT_KEY);
  if (!obj) throw new Error(`Font not found in R2: ${R2_FONT_KEY}`);
  const buffer = await obj.arrayBuffer();
  return { buffer, base64: arrayBufferToBase64(buffer) };
}

export async function getSatoshiFont(bucket: R2Bucket): Promise<{ buffer: ArrayBuffer; base64: string }> {
  if (_base64 && _buffer) return { buffer: _buffer, base64: _base64 };
  const font = await load(bucket);
  if (!_buffer) {
    _buffer = font.buffer;
    _base64 = font.base64;
  }
  return { buffer: _buffer, base64: _base64! };
}
