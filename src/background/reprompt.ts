/**
 * Master password re-prompt, once per popup session.
 *
 * Items with "master password re-prompt" ask for the password before their secrets are used.
 * Asking again for every reveal, copy, and edit in one sitting is tiring and teaches people to
 * turn the protection off, so once the user enters the password in an open popup, that popup may
 * use protected items until it closes or the vault locks.
 *
 * The popup holds a random session id and keeps a port to the worker open while it is showing;
 * the grant lives only in worker memory and only while that port is connected. The popup never
 * keeps the master password itself.
 */
import type { Runtime } from '../shared/browser';
import { POPUP_PORT_PREFIX } from '../shared/messages';

const SESSION_ID = /^[0-9a-f]{32}$/;

export class RepromptGrants {
  /** Popup sessions with a connected port. */
  private readonly open = new Set<string>();
  /** Open sessions that passed the re-prompt. Always a subset of `open`. */
  private readonly verified = new Set<string>();

  /** A popup connected. Returns false for an id that is malformed or already in use. */
  connect(session: string): boolean {
    if (!SESSION_ID.test(session) || this.open.has(session)) return false;
    this.open.add(session);
    return true;
  }

  /** The popup closed (or the worker lost it): its grant goes with it. */
  disconnect(session: string): void {
    this.open.delete(session);
    this.verified.delete(session);
  }

  /** True when this popup session already entered the master password. */
  has(session: string | undefined): boolean {
    return session !== undefined && this.verified.has(session);
  }

  /** Remember a correct master password for this popup session, if it is still open. */
  grant(session: string | undefined): void {
    if (session !== undefined && this.open.has(session)) this.verified.add(session);
  }

  /** Locking the vault ends every grant; open popups ask again after the next unlock. */
  revokeAll(): void {
    this.verified.clear();
  }
}

/**
 * Track popup ports. Only the extension's own pages may open a session, so a content script
 * (and the page it runs in) can never hold a grant.
 */
export function listenForPopups(
  onConnect: { addListener(listener: (port: Runtime.Port) => void): void },
  grants: RepromptGrants,
  extensionId: string,
  extensionUrl: string,
): void {
  onConnect.addListener((port) => {
    if (!port.name.startsWith(POPUP_PORT_PREFIX)) return;
    const sender = port.sender;
    const fromExtensionPage =
      sender?.id === extensionId && sender.url?.startsWith(extensionUrl) === true;
    const session = port.name.slice(POPUP_PORT_PREFIX.length);
    if (!fromExtensionPage || !grants.connect(session)) {
      port.disconnect();
      return;
    }
    port.onDisconnect.addListener(() => {
      grants.disconnect(session);
    });
    // The popup pings so Chrome keeps the worker (and the grant) alive; nothing to answer.
    port.onMessage.addListener(() => undefined);
  });
}
