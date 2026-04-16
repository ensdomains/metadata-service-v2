const fs = require('fs');
const path = require('path');

// Emscripten signature types → WASM type codes
const wasmTypeCodes = { 'v': 0, 'i': 0x7f, 'f': 0x7d, 'd': 0x7c };

function generateTypePack(types) {
  const result = [types.length];
  for (const c of types) {
    result.push(wasmTypeCodes[c]);
  }
  return result;
}

function generateTrampoline(sig) {
  const params = sig.slice(1);
  const ret = sig[0] === 'v' ? '' : sig[0];

  // Type section: 1 func type
  const typeContent = [1, 0x60, ...generateTypePack(params), ...generateTypePack(ret)];
  const typeLen = typeContent.length;
  const typeSection = [1, typeLen, ...typeContent];

  // Import section: import "e"."f" as func type 0
  const importSection = [2, 7, 1, 1, 0x65, 1, 0x66, 0, 0];

  // Export section: export "f" as func 0
  const exportSection = [7, 5, 1, 1, 0x66, 0, 0];

  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, // magic
    0x01, 0x00, 0x00, 0x00, // version
    ...typeSection,
    ...importSection,
    ...exportSection,
  ]);
}

// All signatures used by hbjs.js in rasterize-wasm
const signatures = ['vi', 'viiiffi', 'viiiffffffi', 'viiiffffi', 'viiii', 'iiiii'];

const outDir = path.join(__dirname, '..', 'src', 'wasm-trampolines');
fs.mkdirSync(outDir, { recursive: true });

for (const sig of signatures) {
  const bytes = generateTrampoline(sig);
  const filename = `trampoline-${sig}.wasm`;
  fs.writeFileSync(path.join(outDir, filename), bytes);

  // Verify
  try {
    new WebAssembly.Module(bytes);
    console.log(`${filename}: ${bytes.length} bytes ✓`);
  } catch (e) {
    console.log(`${filename}: INVALID — ${e.message}`);
  }
}
