// @ts-check
/**
 * Refreshes the published site data Vibepass bundles, so autofill works on awkward sites
 * without reverse-engineering each one:
 *
 * - Bitwarden's Map the Web forms map (GPL-3.0): curated CSS selectors for login, sign-up and
 *   password-change fields on sites whose markup hides them. Only the login-related forms and
 *   fields are kept, because the content script loads this on every page.
 * - Apple's password-manager-resources (MIT): password rules for sites that don't declare
 *   `passwordrules`, and groups of sites that share one account.
 *
 * Run it by hand, read the diff, and run `npm run check`. Behind a proxy, Node needs
 * NODE_USE_ENV_PROXY=1.
 *
 *   node scripts/dev/update-site-data.mjs
 */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DATA = fileURLToPath(new URL('../../src/data/', import.meta.url));
const MAP_RELEASE = 'https://github.com/bitwarden/map-the-web/releases/latest/download/';
const APPLE_REPO = 'apple/password-manager-resources';

/** Form categories and field keys that a login filler acts on. */
const CATEGORIES = new Set([
  'account-login',
  'account-creation',
  'account-update',
  'account-recovery',
]);
const FIELDS = new Set(['username', 'email', 'password', 'newPassword', 'oneTimeCode']);

/**
 * @param {string} url
 * @param {'json' | 'text'} [as]
 * @returns {Promise<any>}
 */
async function get(url, as = 'json') {
  const response = await fetch(url, { headers: { 'user-agent': 'vibepass-site-data' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return as === 'json' ? response.json() : response.text();
}

/** @param {any} forms */
function keepForms(forms) {
  if (!Array.isArray(forms)) return undefined;
  const kept = [];
  for (const form of forms) {
    if (!CATEGORIES.has(form.category)) continue;
    const fields = Object.fromEntries(
      Object.entries(form.fields ?? {}).filter(([key]) => FIELDS.has(key)),
    );
    if (Object.keys(fields).length > 0) kept.push({ category: form.category, fields });
  }
  return kept.length > 0 ? kept : undefined;
}

/** @param {any} fragments */
function keepFragments(fragments) {
  if (!fragments) return undefined;
  /** @type {Record<string, unknown>} */
  const kept = {};
  for (const [hash, entry] of Object.entries(fragments)) {
    // null stays: it says the state has no forms, which stops a site-wide entry applying.
    if (entry === null) kept[hash] = null;
    else {
      const forms = keepForms(entry.forms);
      kept[hash] = forms ? { forms } : null;
    }
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/** @param {any} entry */
function keepEntry(entry) {
  if (entry === null) return null;
  /** @type {Record<string, unknown>} */
  const out = {};
  const forms = keepForms(entry.forms);
  if (forms) out.forms = forms;
  const fragments = keepFragments(entry.fragments);
  if (fragments) out.fragments = fragments;
  return out;
}

async function formsMap() {
  const manifest = await get(`${MAP_RELEASE}manifest.json`);
  const filename = manifest.maps?.forms?.v1?.filename;
  if (!filename) throw new Error('Map the Web release has no forms v1 map');
  const map = await get(`${MAP_RELEASE}${filename}`);
  if (!String(map.schemaVersion).startsWith('1.')) {
    throw new Error(`Unexpected forms map schema ${map.schemaVersion}`);
  }
  /** @type {Record<string, unknown>} */
  const hosts = {};
  for (const [host, entry] of Object.entries(/** @type {Record<string, any>} */ (map.hosts))) {
    if (entry === null) {
      hosts[host] = null;
      continue;
    }
    const out = keepEntry(entry) ?? {};
    /** @type {Record<string, unknown>} */
    const pathnames = {};
    for (const [path, page] of Object.entries(
      /** @type {Record<string, any>} */ (entry.pathnames ?? {}),
    )) {
      pathnames[path] = keepEntry(page);
    }
    if (Object.keys(pathnames).length > 0) out.pathnames = pathnames;
    if (Object.keys(out).length > 0) hosts[host] = out;
  }
  return {
    source: `https://github.com/bitwarden/map-the-web/releases/tag/${manifest.buildId}`,
    commit: manifest.gitSha,
    schemaVersion: map.schemaVersion,
    hosts,
  };
}

async function apple() {
  // Pin the files to one commit, so the rules and groups come from the same snapshot.
  const head = execFileSync(
    'git',
    ['ls-remote', `https://github.com/${APPLE_REPO}`, 'refs/heads/main'],
    {
      encoding: 'utf8',
    },
  );
  const commit = head.split(/\s/)[0];
  if (!commit || !/^[0-9a-f]{40}$/.test(commit))
    throw new Error('Could not read Apple main commit');
  /** @param {string} file */
  const raw = (file) =>
    get(`https://raw.githubusercontent.com/${APPLE_REPO}/${commit}/quirks/${file}`);
  const source = `https://github.com/${APPLE_REPO}/tree/${commit}`;
  const rules = await raw('password-rules.json');
  const shared = await raw('shared-credentials.json');
  return {
    passwordRules: {
      source,
      rules: Object.fromEntries(
        Object.entries(/** @type {Record<string, any>} */ (rules))
          .map(([domain, entry]) => [domain.toLowerCase(), entry['password-rules']])
          .filter(([, value]) => typeof value === 'string' && value.trim() !== ''),
      ),
    },
    sharedCredentials: {
      source,
      groups: /** @type {any[]} */ (shared).map((group) =>
        group.shared ? { shared: group.shared } : { from: group.from, to: group.to },
      ),
    },
  };
}

/** @param {unknown} value */
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const map = await formsMap();
await writeFile(`${DATA}forms-map.json`, json(map));
const { passwordRules, sharedCredentials } = await apple();
await writeFile(`${DATA}apple-password-rules.json`, json(passwordRules));
await writeFile(`${DATA}apple-shared-credentials.json`, json(sharedCredentials));
console.log(
  `forms map ${map.schemaVersion}: ${Object.keys(map.hosts).length} hosts; ` +
    `${Object.keys(passwordRules.rules).length} password rules; ` +
    `${sharedCredentials.groups.length} shared-credential groups`,
);
