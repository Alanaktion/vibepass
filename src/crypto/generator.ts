/**
 * Password and passphrase generation, from Bitwarden's SDK so Vibepass makes the same kind of
 * passwords as the official clients (same character sets, the EFF long word list, and the
 * `passwordrules` parser for sites that declare their rules). The SDK's generator is stateless;
 * it is reached through a client object that holds no keys or vault data (see ADR 0002).
 */
import * as glue from '@bitwarden/sdk-internal/bitwarden_wasm_internal_bg.js';
import type { GeneratorClient, PasswordGeneratorRequest } from '@bitwarden/sdk-internal';
import { sdk } from './sdk';

import {
  PASSPHRASE_WORDS,
  PASSWORD_LENGTH,
  type GeneratorOptions,
  type PasswordOptions,
} from './generator-options';

export * from './generator-options';

let client: GeneratorClient | null = null;

async function generator(): Promise<GeneratorClient> {
  await sdk();
  if (!client) {
    // The token provider is never called: the generator makes no requests.
    const pm = new glue.PasswordManagerClient(
      { get_access_token: () => Promise.resolve(undefined) },
      null,
      new glue.ManagedSettingsClient(),
    );
    client = pm.generator();
  }
  return client;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(Number.isFinite(value) ? value : min)));

function passwordRequest(options: PasswordOptions): PasswordGeneratorRequest {
  // At least one character set, or the SDK refuses; fall back to letters and numbers.
  const any = options.uppercase || options.lowercase || options.numbers || options.symbols;
  const sets = any ? options : { ...options, uppercase: true, lowercase: true, numbers: true };
  return {
    lowercase: sets.lowercase,
    uppercase: sets.uppercase,
    numbers: sets.numbers,
    special: sets.symbols,
    length: clamp(options.length, PASSWORD_LENGTH.min, PASSWORD_LENGTH.max),
    avoidAmbiguous: options.avoidAmbiguous,
    minLowercase: sets.lowercase ? 1 : undefined,
    minUppercase: sets.uppercase ? 1 : undefined,
    minNumber: sets.numbers ? 1 : undefined,
    minSpecial: sets.symbols ? 1 : undefined,
  };
}

/** Generate a password or passphrase. Options out of range are clamped, not rejected. */
export async function generate(options: GeneratorOptions): Promise<string> {
  const gen = await generator();
  if (options.kind === 'passphrase') {
    return gen.passphrase({
      numWords: clamp(options.words, PASSPHRASE_WORDS.min, PASSPHRASE_WORDS.max),
      // The SDK needs a separator; an empty one would make words run together anyway.
      wordSeparator: options.separator || '-',
      capitalize: options.capitalize,
      includeNumber: options.includeNumber,
    });
  }
  return gen.password(passwordRequest(options));
}

/**
 * Generate a password that follows a site's `passwordrules` attribute, when it has a usable
 * one; otherwise use the user's own options.
 */
export async function generateForRules(
  rules: string | null,
  fallback: GeneratorOptions,
): Promise<string> {
  if (rules?.trim()) {
    try {
      const gen = await generator();
      return gen.password(gen.password_rules(rules));
    } catch {
      // Rules we can't satisfy or parse: the user's settings are a safe default.
    }
  }
  return generate(fallback);
}
