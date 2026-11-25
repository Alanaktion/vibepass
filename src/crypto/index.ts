/**
 * Bitwarden-compatible crypto, backed by Bitwarden's SDK (see docs/adr/0001-crypto-sdk.md).
 *
 * Everything else in the extension goes through these functions rather than the SDK directly,
 * so the SDK stays an implementation detail. Keys are opaque byte arrays that live only in
 * background memory and `storage.session`.
 */
export * from './types';
export * from './kdf';
export * from './keys';
export { sdk, setWasmSource, SDK_WASM_PATH } from './sdk';
