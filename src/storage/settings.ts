import browser from '../shared/browser';

/** Non-sensitive user settings in `storage.local`. Never put keys or vault data here. */
export interface Settings {
  /** Minutes without keyboard or mouse input before auto-lock. 0 turns idle lock off. */
  lockAfterMinutes: number;
  /** Lock when the computer locks or sleeps. */
  lockOnSystemLock: boolean;
  /** Seconds before a copied secret is cleared from the clipboard. 0 turns clearing off. */
  clipboardClearSeconds: number;
  /** Show website icons from your server's icon service (it sees which sites you have). */
  showIcons: boolean;
  /** After filling a login that has a one-time password, copy the code. */
  autoCopyTotp: boolean;
  /** Show a menu of matching logins under login fields on web pages. */
  inlineMenu: boolean;
  /**
   * Let Vibepass change the vault: create, edit, organize, and delete items. Off by default
   * while write support is new (Phase 2 gate).
   */
  allowEdits: boolean;
  /** After signing in or changing a password on a site, offer to save or update the login. */
  offerToSave: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  lockAfterMinutes: 15,
  lockOnSystemLock: true,
  clipboardClearSeconds: 30,
  showIcons: true,
  autoCopyTotp: true,
  inlineMenu: true,
  allowEdits: false,
  offerToSave: true,
};

export const LOCK_AFTER_CHOICES = [1, 5, 15, 30, 60, 240, 0] as const;
export const CLIPBOARD_CLEAR_CHOICES = [10, 20, 30, 60, 120, 300, 0] as const;

const KEY = 'settings';

/** Drop unknown keys and wrong types, so a bad stored value can't break the worker. */
export function sanitizeSettings(input: unknown): Partial<Settings> {
  const value = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const out: Partial<Settings> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const candidate = value[key];
    if (typeof candidate !== typeof DEFAULT_SETTINGS[key]) continue;
    if (typeof candidate === 'number' && (!Number.isFinite(candidate) || candidate < 0)) continue;
    (out as Record<string, unknown>)[key] = candidate;
  }
  return out;
}

export async function loadSettings(): Promise<Settings> {
  const stored = (await browser.storage.local.get(KEY))[KEY];
  return { ...DEFAULT_SETTINGS, ...sanitizeSettings(stored) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...sanitizeSettings(patch) };
  await browser.storage.local.set({ [KEY]: next });
  return next;
}
