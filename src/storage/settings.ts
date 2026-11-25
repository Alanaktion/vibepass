import browser from '../shared/browser';

/** Non-sensitive user settings in `storage.local`. Never put keys or vault data here. */
export interface Settings {
  serverUrl: string | null;
  email: string | null;
  /** Minutes of idle time before auto-lock. 0 disables idle lock. */
  lockAfterMinutes: number;
  clipboardClearSeconds: number;
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: null,
  email: null,
  lockAfterMinutes: 15,
  clipboardClearSeconds: 30,
};

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const stored = (await browser.storage.local.get(KEY))[KEY] as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await browser.storage.local.set({ [KEY]: next });
  return next;
}
