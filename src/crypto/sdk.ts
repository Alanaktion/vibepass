/**
 * Loads Bitwarden's SDK (`@bitwarden/sdk-internal`, GPL-3.0) and exposes its stateless crypto.
 *
 * MV3 service workers can't use dynamic import() or top-level await, and Vite can't bundle a
 * .wasm ES module import, so we bundle the wasm-bindgen glue and instantiate the .wasm file
 * (copied to `sdk/` by scripts/build.mjs) on first use. Listeners stay synchronous; only the
 * first crypto call waits for the module.
 */
import * as glue from '@bitwarden/sdk-internal/bitwarden_wasm_internal_bg.js';
import type { PureCrypto as PureCryptoClass } from '@bitwarden/sdk-internal';
import browser from '../shared/browser';

export type PureCrypto = typeof PureCryptoClass;
export type { Kdf as SdkKdf } from '@bitwarden/sdk-internal';

/** Path of the .wasm file inside the built extension. */
export const SDK_WASM_PATH = 'sdk/bitwarden_wasm_internal_bg.wasm';

export type WasmSource = () => Promise<BufferSource>;

let source: WasmSource = defaultSource;
let loading: Promise<PureCrypto> | null = null;

async function defaultSource(): Promise<BufferSource> {
  const response = await fetch(browser.runtime.getURL(SDK_WASM_PATH));
  if (!response.ok)
    throw new Error(`Could not load the crypto module (${String(response.status)})`);
  return response.arrayBuffer();
}

/** Override where the .wasm bytes come from (tests read them from node_modules). */
export function setWasmSource(next: WasmSource): void {
  source = next;
  loading = null;
}

/** Returns the SDK's PureCrypto, instantiating the WebAssembly module on first call. */
export function sdk(): Promise<PureCrypto> {
  loading ??= (async () => {
    const bytes = await source();
    const { instance } = await WebAssembly.instantiate(bytes, {
      './bitwarden_wasm_internal_bg.js': glue as unknown as WebAssembly.ModuleImports,
    });
    glue.__wbg_set_wasm(instance.exports);
    return glue.PureCrypto;
  })().catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}
