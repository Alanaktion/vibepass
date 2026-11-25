/** Generator options and defaults, without the SDK, so the popup can use them. */
export interface PasswordOptions {
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  numbers: boolean;
  symbols: boolean;
  avoidAmbiguous: boolean;
}

export interface PassphraseOptions {
  words: number;
  separator: string;
  capitalize: boolean;
  includeNumber: boolean;
}

export type GeneratorOptions =
  ({ kind: 'password' } & PasswordOptions) | ({ kind: 'passphrase' } & PassphraseOptions);

export const DEFAULT_PASSWORD: PasswordOptions = {
  length: 20,
  uppercase: true,
  lowercase: true,
  numbers: true,
  symbols: true,
  avoidAmbiguous: false,
};

export const DEFAULT_PASSPHRASE: PassphraseOptions = {
  words: 4,
  separator: '-',
  capitalize: true,
  includeNumber: true,
};

export const PASSWORD_LENGTH = { min: 8, max: 128 } as const;
export const PASSPHRASE_WORDS = { min: 3, max: 20 } as const;
