// @ts-check
/**
 * Seeds a test account on a local Vaultwarden with a known vault for live checks: logins (one
 * with TOTP, a custom hidden field, and an attachment), a re-prompt login, a secure note, a
 * card, and an organization with a collection and a shared login. Optionally turns on
 * authenticator two-step login. Dev and test use only; never point it at a real account.
 *
 *   node scripts/dev/seed-vault.mjs <serverUrl> <email> <siteUrl> [--two-factor]
 *
 * Prints a JSON summary (item ids).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import * as glue from '@bitwarden/sdk-internal/bitwarden_wasm_internal_bg.js';

const password = process.env.VIBEPASS_TEST_PASSWORD;
const args = process.argv.slice(2);
const twoFactor = args.includes('--two-factor');
const [serverUrl, email, siteUrl] = args.filter((a) => !a.startsWith('--'));
if (!serverUrl || !email || !password || !siteUrl) {
  console.error(
    'Set VIBEPASS_TEST_PASSWORD and run: seed-vault.mjs <serverUrl> <email> <siteUrl> [--two-factor]',
  );
  process.exit(2);
}
const base = serverUrl.replace(/\/+$/, '');

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
const enc = new TextEncoder();
const b64 = (/** @type {Uint8Array} */ bytes) => Buffer.from(bytes).toString('base64');

/** @param {string} path @param {RequestInit} [init] */
async function call(path, init = {}) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: ${String(res.status)}`);
  return text ? JSON.parse(text) : null;
}

// Log in.
const prelogin = await call('/identity/accounts/prelogin', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email }),
});
const salt = email.trim().toLowerCase();
const kdf =
  prelogin.kdf === 1
    ? {
        argon2id: {
          iterations: prelogin.kdfIterations,
          memory: prelogin.kdfMemory,
          parallelism: prelogin.kdfParallelism,
        },
      }
    : { pBKDF2: { iterations: prelogin.kdfIterations } };
const masterKey = pc.derive_kdf_material(enc.encode(password), enc.encode(salt), kdf);
const hashKey = await webcrypto.subtle.importKey('raw', masterKey, 'PBKDF2', false, ['deriveBits']);
const masterPasswordHash = b64(
  new Uint8Array(
    await webcrypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(password), iterations: 1 },
      hashKey,
      256,
    ),
  ),
);
const token = await call('/identity/connect/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'password',
    username: email,
    password: masterPasswordHash,
    scope: 'api offline_access',
    client_id: 'web',
    deviceType: '9',
    deviceIdentifier: webcrypto.randomUUID(),
    deviceName: 'seed-script',
  }).toString(),
});
// Vaultwarden 1.35+ wants the encrypting user's id on every cipher write.
const userId = JSON.parse(
  Buffer.from(token.access_token.split('.')[1], 'base64url').toString(),
).sub;
const auth = { authorization: `Bearer ${token.access_token}` };
const json = { ...auth, 'content-type': 'application/json' };
const userKey = pc.decrypt_user_key_with_master_password(token.Key, password, salt, kdf);
const privateKey = pc.unwrap_decapsulation_key(token.PrivateKey, userKey);
const publicKey = pc.rsa_extract_public_key(privateKey);

/** @param {Uint8Array} key */
const encryptor = (key) => (/** @type {string | null} */ value) =>
  value === null ? null : pc.symmetric_encrypt_string(value, key);

/** @param {Uint8Array} key @param {Record<string, unknown>} item */
function cipher(key, item) {
  const e = encryptor(key);
  const login = /** @type {any} */ (item.login);
  return {
    encryptedFor: userId,
    type: item.type,
    name: e(/** @type {string} */ (item.name)),
    notes: e(/** @type {string | null} */ (item.notes ?? null)),
    favorite: item.favorite ?? false,
    reprompt: item.reprompt ?? 0,
    folderId: null,
    organizationId: item.organizationId ?? null,
    login: login
      ? {
          username: e(login.username),
          password: e(login.password),
          totp: e(login.totp ?? null),
          uris: login.uris.map((/** @type {string} */ uri) => ({ uri: e(uri), match: null })),
        }
      : null,
    secureNote: item.type === 2 ? { type: 0 } : null,
    card: item.card
      ? Object.fromEntries(
          Object.entries(/** @type {Record<string, string>} */ (item.card)).map(([k, v]) => [
            k,
            e(v),
          ]),
        )
      : null,
    fields: /** @type {{ name: string; value: string; type: number }[]} */ (item.fields ?? []).map(
      (f) => ({ name: e(f.name), value: e(f.value), type: f.type }),
    ),
  };
}

const site = new URL(siteUrl).origin;
const created = {};

const totpSeed = 'JBSWY3DPEHPK3PXP';
const main = await call('/api/ciphers', {
  method: 'POST',
  headers: json,
  body: JSON.stringify(
    cipher(userKey, {
      type: 1,
      name: 'Local Test Site',
      notes: 'Seeded by scripts/dev/seed-vault.mjs',
      favorite: true,
      login: {
        username: 'alice@example.test',
        password: 'correct-horse-42',
        totp: totpSeed,
        uris: [`${site}/login`],
      },
      fields: [{ name: 'Recovery PIN', value: '2468', type: 1 }],
    }),
  ),
});
Object.assign(created, { login: main.id });

const reprompt = await call('/api/ciphers', {
  method: 'POST',
  headers: json,
  body: JSON.stringify(
    cipher(userKey, {
      type: 1,
      name: 'Bank (re-prompt)',
      reprompt: 1,
      login: { username: 'alice', password: 'bank-secret-9', uris: ['https://bank.example.test'] },
    }),
  ),
});
Object.assign(created, { reprompt: reprompt.id });

for (const item of [
  { type: 2, name: 'Wi-Fi', notes: 'Network: home\nPassword: router-fridge-7' },
  {
    type: 3,
    name: 'Visa',
    card: {
      cardholderName: 'Alice Example',
      brand: 'Visa',
      number: '4111111111111111',
      expMonth: '4',
      expYear: '2030',
      code: '123',
    },
  },
]) {
  await call('/api/ciphers', {
    method: 'POST',
    headers: json,
    body: JSON.stringify(cipher(userKey, item)),
  });
}

// Attachment on the main login.
const fileKey = pc.make_user_key_aes256_cbc_hmac();
const fileData = pc.symmetric_encrypt_filedata(enc.encode('hello from an attachment\n'), fileKey);
const attachment = await call(`/api/ciphers/${main.id}/attachment/v2`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({
    key: pc.wrap_symmetric_key(fileKey, userKey),
    fileName: pc.symmetric_encrypt_string('hello.txt', userKey),
    fileSize: fileData.length,
    adminRequest: false,
  }),
});
const form = new FormData();
form.append('data', new Blob([Buffer.from(fileData)]), 'hello.txt');
await call(`/api/ciphers/${main.id}/attachment/${attachment.attachmentId}`, {
  method: 'POST',
  headers: auth,
  body: form,
});

// Organization with a collection and a shared login.
const orgKey = pc.make_user_key_aes256_cbc_hmac();
const orgPrivate = pc.rsa_generate_keypair();
const org = await call('/api/organizations', {
  method: 'POST',
  headers: json,
  body: JSON.stringify({
    name: 'Acme',
    billingEmail: email,
    planType: 0,
    key: pc.encapsulate_key_unsigned(orgKey, publicKey),
    keys: {
      publicKey: b64(pc.rsa_extract_public_key(orgPrivate)),
      encryptedPrivateKey: pc.wrap_decapsulation_key(orgPrivate, orgKey),
    },
    collectionName: pc.symmetric_encrypt_string('Engineering', orgKey),
  }),
});
const collections = await call(`/api/organizations/${org.id}/collections`, { headers: auth });
const collectionId = collections.data[0].id;
const shared = await call('/api/ciphers/create', {
  method: 'POST',
  headers: json,
  body: JSON.stringify({
    cipher: cipher(orgKey, {
      type: 1,
      name: 'Team Wiki',
      organizationId: org.id,
      login: { username: 'team@example.test', password: 'team-secret-1', uris: [`${site}/team`] },
    }),
    collectionIds: [collectionId],
  }),
});
Object.assign(created, { organization: org.id, shared: shared.id });

if (twoFactor) {
  const seedFile = process.env.VIBEPASS_TEST_TOTP_FILE;
  if (!seedFile) throw new Error('Set VIBEPASS_TEST_TOTP_FILE to a new private file');
  // Vaultwarden hands out the secret and a verification token first, then enables it.
  const setup = await call('/api/two-factor/get-authenticator', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ masterPasswordHash }),
  });
  const secret = setup.authenticator?.key ?? setup.key;
  const { generateTotp } = await import('../../src/vault/totp.ts');
  await writeFile(seedFile, secret, { mode: 0o600, flag: 'wx' });
  const code = (await generateTotp(secret, Date.now())).code;
  await call('/api/two-factor/authenticator', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      key: secret,
      token: code,
      masterPasswordHash,
      userVerificationToken: setup.userVerificationToken,
    }),
  });
}

console.log(JSON.stringify(created, null, 2));
