/**
 * The SDK's bundler entry (`index.js`) imports the .wasm file as an ES module, which neither
 * Vite's library build nor MV3 service workers support. We import the wasm-bindgen glue
 * directly and instantiate the WebAssembly module ourselves (see src/crypto/sdk.ts).
 */
declare module '@bitwarden/sdk-internal/bitwarden_wasm_internal_bg.js' {
  export * from '@bitwarden/sdk-internal';
  export function __wbg_set_wasm(exports: WebAssembly.Exports): void;
}
