import browser from '../shared/browser';
import {
  DEFAULT_PASSPHRASE,
  DEFAULT_PASSWORD,
  type GeneratorOptions,
  type PassphraseOptions,
  type PasswordOptions,
} from '../crypto/generator-options';
import type { EncString } from '../crypto/types';

/**
 * The generator's last-used options (not sensitive) and its history of generated passwords, in
 * `storage.local`. History entries are encrypted with the user key, like the refresh token, so
 * they are unreadable while the vault is locked.
 */
const OPTIONS_KEY = 'generatorOptions';
const HISTORY_KEY = 'generatorHistory';

/** Generated passwords kept so a failed save never loses one. */
export const HISTORY_LIMIT = 20;

export interface StoredGeneratorOptions {
  kind: 'password' | 'passphrase';
  password: PasswordOptions;
  passphrase: PassphraseOptions;
}

export const DEFAULT_GENERATOR: StoredGeneratorOptions = {
  kind: 'password',
  password: DEFAULT_PASSWORD,
  passphrase: DEFAULT_PASSPHRASE,
};

function pick<T extends object>(defaults: T, input: unknown): T {
  const value = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const out = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    const candidate = value[key as string];
    if (typeof candidate === typeof defaults[key]) out[key] = candidate as T[keyof T];
  }
  return out;
}

export function sanitizeGenerator(input: unknown): StoredGeneratorOptions {
  const value = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  return {
    kind: value.kind === 'passphrase' ? 'passphrase' : 'password',
    password: pick(DEFAULT_PASSWORD, value.password),
    passphrase: pick(DEFAULT_PASSPHRASE, value.passphrase),
  };
}

/** The options for the kind currently picked. */
export function activeOptions(stored: StoredGeneratorOptions): GeneratorOptions {
  return stored.kind === 'passphrase'
    ? { kind: 'passphrase', ...stored.passphrase }
    : { kind: 'password', ...stored.password };
}

export const generatorStore = {
  async loadOptions(): Promise<StoredGeneratorOptions> {
    return sanitizeGenerator((await browser.storage.local.get(OPTIONS_KEY))[OPTIONS_KEY]);
  },
  async saveOptions(options: StoredGeneratorOptions): Promise<void> {
    await browser.storage.local.set({ [OPTIONS_KEY]: sanitizeGenerator(options) });
  },
  async loadHistory(): Promise<EncString[]> {
    const stored = (await browser.storage.local.get(HISTORY_KEY))[HISTORY_KEY];
    return Array.isArray(stored) ? stored.filter((e): e is string => typeof e === 'string') : [];
  },
  async saveHistory(entries: EncString[]): Promise<void> {
    await browser.storage.local.set({ [HISTORY_KEY]: entries.slice(0, HISTORY_LIMIT) });
  },
  async clearHistory(): Promise<void> {
    await browser.storage.local.remove(HISTORY_KEY);
  },
};
