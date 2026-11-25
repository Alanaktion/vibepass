import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setWasmSource } from '../src/crypto/sdk';

/** In tests the SDK's .wasm comes straight from node_modules instead of the built extension. */
const require = createRequire(import.meta.url);
const wasmPath = require.resolve('@bitwarden/sdk-internal/bitwarden_wasm_internal_bg.wasm');
setWasmSource(() => readFile(wasmPath));
