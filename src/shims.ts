// Polyfills for Cloudflare Workers compatibility
// Must be imported before any WASM modules

// harfbuzzjs reads self.location.href at init
if (typeof globalThis.location === 'undefined') {
  (globalThis as any).location = { href: '' };
}

// harfbuzzjs uses __dirname to find hb.wasm in Node.js mode
if (typeof globalThis.__dirname === 'undefined') {
  (globalThis as any).__dirname = '/';
}
