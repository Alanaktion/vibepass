/**
 * The browser's built-in password manager (privacy.services.passwordSavingEnabled). There is no
 * extension API to register as the browser's password provider, so, like the official
 * Bitwarden extension, we offer to turn the built-in one off: no "save password?" prompts and
 * no built-in autofill competing with ours (and, later, with the inline menu).
 *
 * The "privacy" permission is optional and requested only when the user flips the switch.
 */
import browser from '../shared/browser';

export type BuiltInState =
  /** We haven't been given the permission, so we can't tell. */
  | 'unknown'
  /** The browser's password manager is on. */
  | 'on'
  /** Vibepass turned it off. */
  | 'off-by-us'
  /** Off, but set by the user, policy, or another extension. */
  | 'off'
  /** Another extension (for example Bitwarden) controls it. */
  | 'other-extension'
  /** Locked by policy. */
  | 'locked';

const PERMISSION = { permissions: ['privacy' as const] };

export async function builtInPasswordState(): Promise<BuiltInState> {
  try {
    if (!(await browser.permissions.contains(PERMISSION))) return 'unknown';
    const { value, levelOfControl } = await browser.privacy.services.passwordSavingEnabled.get({});
    if (levelOfControl === 'not_controllable') return 'locked';
    if (levelOfControl === 'controlled_by_other_extensions') return 'other-extension';
    if (value === false)
      return levelOfControl === 'controlled_by_this_extension' ? 'off-by-us' : 'off';
    return 'on';
  } catch {
    return 'unknown';
  }
}

/** Turn the built-in password manager off (true) or hand control back (false). */
export async function setBuiltInPasswordsOff(off: boolean): Promise<BuiltInState> {
  if (off) {
    // Must be the first await, so the browser still sees the click that asked.
    if (!(await browser.permissions.request(PERMISSION))) return builtInPasswordState();
    await browser.privacy.services.passwordSavingEnabled.set({ value: false });
  } else if (await browser.permissions.contains(PERMISSION)) {
    await browser.privacy.services.passwordSavingEnabled.clear({});
  }
  return builtInPasswordState();
}
