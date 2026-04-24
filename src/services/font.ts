// Singleton font loader — fetches Satoshi-Bold from R2, memoizes for isolate lifetime

const R2_FONT_KEY = 'fonts/Satoshi-Bold.ttf';

let _base64: string | null = null;
let _buffer: ArrayBuffer | null = null;
let _pending: Promise<void> | null = null;

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function load(bucket: R2Bucket): Promise<void> {
  const obj = await bucket.get(R2_FONT_KEY);
  if (!obj) throw new Error(`Font not found in R2: ${R2_FONT_KEY}`);
  _buffer = await obj.arrayBuffer();
  _base64 = arrayBufferToBase64(_buffer);
}

export async function getSatoshiFont(bucket: R2Bucket): Promise<{ buffer: ArrayBuffer; base64: string }> {
  if (_base64 && _buffer) return { buffer: _buffer, base64: _base64 };
  if (!_pending) _pending = load(bucket).finally(() => { _pending = null; });
  await _pending;
  return { buffer: _buffer!, base64: _base64! };
}
