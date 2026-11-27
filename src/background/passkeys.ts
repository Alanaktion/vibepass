/**
 * Passkeys, worker side. A page's navigator.credentials call reaches here through the passkey
 * content script, which asks the user first. The worker checks the page's origin itself (from
 * the message sender, never from the page), finds passkeys for the site, and signs. Pages get
 * the signed response only; private keys never leave the worker.
 */
import { CodedError } from '../shared/errors';
import { log } from '../shared/log';
import type { PasskeyCreateOptions, PasskeyGetOptions } from '../shared/messages';
import type {
  AssertionJson,
  AttestationJson,
  PasskeyCreateRequest,
  PasskeyGetRequest,
} from '../shared/webauthn';
import type { SearchIndex } from '../search';
import type { Settings } from '../storage/settings';
import type { DecryptedCipher } from '../vault/decrypt';
import {
  ES256,
  createPasskey,
  credentialIdForPage,
  isValidRpId,
  signAssertion,
  type StoredPasskey,
} from '../vault/passkey';
import { CipherType } from '../vault/types';
import type { VaultState } from '../vault/state';
import type { VaultService } from './service';

export interface PasskeyDeps {
  vault: VaultState;
  search: SearchIndex;
  service: VaultService;
  settings(): Promise<Settings>;
  now?: () => number;
}

/** The page's origin and the RP id it may use, or null when WebAuthn isn't allowed there. */
function site(pageUrl: string, rpId: string | null): { origin: string; rpId: string } | null {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  const id = (rpId ?? url.hostname).toLowerCase();
  return isValidRpId(id, pageUrl) ? { origin: url.origin, rpId: id } : null;
}

function passkeysFor(item: DecryptedCipher, rpId: string): StoredPasskey[] {
  return (item.login?.passkeys ?? []).filter((p) => p.rpId.toLowerCase() === rpId);
}

export function createPasskeys(deps: PasskeyDeps) {
  const now = deps.now ?? (() => Date.now());

  async function enabled(): Promise<boolean> {
    return (await deps.settings()).passkeys;
  }

  /**
   * Whether Vibepass would answer passkey requests on this page. Sites ask before offering
   * passkey sign-in (Microsoft hides it without a platform authenticator), so this says yes
   * whenever the setting is on and the page may use WebAuthn, locked or not, and says nothing
   * about which passkeys the vault holds.
   */
  async function available(pageUrl: string): Promise<boolean> {
    return site(pageUrl, null) !== null && (await enabled());
  }

  async function getOptions(
    pageUrl: string,
    request: { rpId: string | null; allowCredentials: string[] },
  ): Promise<PasskeyGetOptions> {
    const where = site(pageUrl, request.rpId);
    if (!where || !(await enabled())) return { state: 'off' };
    await deps.service.status();
    if (!deps.vault.isUnlocked) return { state: 'locked' };
    const allowed = new Set(request.allowCredentials);
    const passkeys = [];
    for (const item of await deps.service.passkeyLogins()) {
      if (item.reprompt) continue;
      for (const passkey of passkeysFor(item, where.rpId)) {
        const id = credentialIdForPage(passkey.credentialId);
        if (!id) continue;
        if (allowed.size > 0 ? !allowed.has(id) : !passkey.discoverable) continue;
        passkeys.push({
          cipherId: item.id,
          credentialId: passkey.credentialId,
          name: item.name,
          userName: passkey.userName ?? item.login?.username ?? null,
        });
      }
    }
    return { state: 'ready', rpId: where.rpId, passkeys };
  }

  async function get(
    pageUrl: string,
    request: PasskeyGetRequest,
    cipherId: string,
    credentialId: string,
  ): Promise<AssertionJson> {
    const where = site(pageUrl, request.rpId);
    if (!where) throw new Error('This page can’t use passkeys');
    if (!(await enabled())) throw new Error('Passkeys are turned off in Vibepass');
    const item = await deps.service.passkeyLogin(cipherId);
    if (item.deletedDate) throw new Error('That passkey is in the trash');
    const passkey = passkeysFor(item, where.rpId).find((p) => p.credentialId === credentialId);
    if (!passkey) throw new Error('That passkey isn’t saved for this site');
    const page = credentialIdForPage(passkey.credentialId);
    if (
      request.allowCredentials.length > 0 &&
      (!page || !request.allowCredentials.includes(page))
    ) {
      throw new Error('This site didn’t ask for that passkey');
    }

    // Like the official clients: synced passkeys start at 0 and stay there, which tells sites
    // not to check the counter. Imported passkeys that count keep counting.
    let counter = passkey.counter;
    if (counter > 0) {
      counter += 1;
      if ((await deps.settings()).allowEdits) {
        await deps.service.savePasskeyCounter(item.id, passkey.credentialId, counter).catch(() => {
          log.warn('passkey counter not saved');
        });
      }
    }
    return signAssertion(passkey, { challenge: request.challenge, origin: where.origin, counter });
  }

  async function createOptions(
    pageUrl: string,
    request: {
      rpId: string | null;
      algorithms: number[];
      excludeCredentials: string[];
      userName: string;
    },
  ): Promise<PasskeyCreateOptions> {
    const where = site(pageUrl, request.rpId);
    if (!where || !request.algorithms.includes(ES256)) return { state: 'off' };
    const settings = await deps.settings();
    if (!settings.passkeys || !settings.allowEdits) return { state: 'off' };
    await deps.service.status();
    if (!deps.vault.isUnlocked) return { state: 'locked' };

    const excluded = new Set(request.excludeCredentials);
    if (excluded.size > 0) {
      for (const item of await deps.service.passkeyLogins()) {
        const hit = passkeysFor(item, where.rpId).some((p) => {
          const id = credentialIdForPage(p.credentialId);
          return id !== null && excluded.has(id);
        });
        if (hit) return { state: 'excluded', rpId: where.rpId, name: item.name };
      }
    }

    // Logins for this site that have no passkey yet; the one with the same username first.
    const logins = deps.search
      .matchesFor(pageUrl)
      .filter((m) => {
        if (m.type !== CipherType.Login || m.reprompt) return false;
        const raw = deps.vault.raw(m.id);
        return raw !== null && raw.edit !== false && !raw.login?.fido2Credentials?.length;
      })
      .map((m) => ({ id: m.id, name: m.name, username: m.subtitle }));
    const same = logins.findIndex((l) => l.username === request.userName);
    if (same > 0) logins.unshift(...logins.splice(same, 1));
    return { state: 'ready', rpId: where.rpId, logins };
  }

  async function create(
    pageUrl: string,
    request: PasskeyCreateRequest,
    cipherId: string | null,
  ): Promise<AttestationJson> {
    const where = site(pageUrl, request.rp.id);
    if (!where) throw new Error('This page can’t use passkeys');
    if (!request.algorithms.includes(ES256)) {
      throw new Error('This site doesn’t accept the passkey type Vibepass makes');
    }
    const settings = await deps.settings();
    if (!settings.passkeys) throw new Error('Passkeys are turned off in Vibepass');
    if (!settings.allowEdits) {
      throw new CodedError('Turn on editing in Settings to save passkeys', 'writes-off');
    }
    const { passkey, response } = await createPasskey({
      rpId: where.rpId,
      rpName: request.rp.name || where.rpId,
      userHandle: request.user.id,
      userName: request.user.name,
      userDisplayName: request.user.displayName,
      discoverable: request.residentKey,
      challenge: request.challenge,
      origin: where.origin,
      credProps: request.credProps,
      now: new Date(now()),
    });
    // Saved before the site hears about it, so a passkey the site knows is always in the vault.
    await deps.service.savePasskey(cipherId, passkey);
    return response;
  }

  return { available, getOptions, get, createOptions, create };
}
