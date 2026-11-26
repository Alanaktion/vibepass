// @ts-check
/**
 * Registers a test account on a local Vaultwarden server, with keys made by Bitwarden's SDK.
 * Dev and test use only.
 *
 *   node scripts/dev/register-account.mjs <serverUrl> <email> [pbkdf2|argon2id]
 *
 * For a self-signed local server, run with NODE_EXTRA_CA_CERTS=<cert.pem>.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import * as glue from '@bitwarden/sdk-internal/bitwarden_wasm_internal_bg.js';

const password = process.env.VIBEPASS_TEST_PASSWORD;
const [serverUrl, email, kdfName = 'pbkdf2'] = process.argv.slice(2);
if (!serverUrl || !email || !password) {
  console.error(
    'Set VIBEPASS_TEST_PASSWORD and run: register-account.mjs <serverUrl> <email> [pbkdf2|argon2id]',
  );
  process.exit(2);
}

const require = createRequire(import.meta.url);
const { instance } = await WebAssembly.instantiate(
  await readFile(require.resolve('@bitwarden/sdk-internal/bitwarden_wasm_internal_bg.wasm')),
  {
    './bitwarden_wasm_internal_bg.js': /** @type {WebAssembly.ModuleImports} */ (
      /** @type {unknown} */ (glue)
    ),
  },
);
glue.__wbg_set_wasm(instance.exports);
const pc = glue.PureCrypto;

const salt = email.trim().toLowerCase();
const kdf =
  kdfName === 'argon2id'
    ? { argon2id: { iterations: 3, memory: 64, parallelism: 4 } }
    : { pBKDF2: { iterations: 600000 } };
const enc = new TextEncoder();
const masterKey = pc.derive_kdf_material(enc.encode(password), enc.encode(salt), kdf);
const base = await webcrypto.subtle.importKey('raw', masterKey, 'PBKDF2', false, ['deriveBits']);
const hashBits = await webcrypto.subtle.deriveBits(
  { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(password), iterations: 1 },
  base,
  256,
);
const userKey = pc.make_user_key_aes256_cbc_hmac();
const privateKey = pc.rsa_generate_keypair();
const baseUrl = serverUrl.replace(/\/+$/, '');
const tokenRes = await fetch(`${baseUrl}/identity/accounts/register/send-verification-email`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, name: 'Test User', receiveMarketingEmails: false }),
});
if (!tokenRes.ok) throw new Error(`send-verification-email: ${String(tokenRes.status)}`);
// With no mail server configured, Vaultwarden returns the verification token directly.
const emailVerificationToken = (await tokenRes.text()).replace(/^"|"$/g, '');
const body = {
  email,
  emailVerificationToken,
  masterPasswordHash: Buffer.from(hashBits).toString('base64'),
  masterPasswordHint: null,
  userSymmetricKey: pc.encrypt_user_key_with_master_password(userKey, password, salt, kdf),
  userAsymmetricKeys: {
    publicKey: Buffer.from(pc.rsa_extract_public_key(privateKey)).toString('base64'),
    encryptedPrivateKey: pc.wrap_decapsulation_key(privateKey, userKey),
  },
  kdf: kdfName === 'argon2id' ? 1 : 0,
  kdfIterations: kdfName === 'argon2id' ? 3 : 600000,
  kdfMemory: kdfName === 'argon2id' ? 64 : null,
  kdfParallelism: kdfName === 'argon2id' ? 4 : null,
};
const res = await fetch(`${baseUrl}/identity/accounts/register/finish`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
console.log(String(res.status), res.ok ? 'registered' : 'registration failed');
if (!res.ok) process.exit(1);
