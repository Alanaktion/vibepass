import { describe, expect, it, vi } from 'vitest';
import browser, { type Runtime } from 'webextension-polyfill';
import { RepromptGrants, listenForPopups } from '../src/background/reprompt';
import { pw } from '../src/popup/actions';
import { popupSession, startPopupSession } from '../src/popup/session';
import { POPUP_PORT_PREFIX } from '../src/shared/messages';

const EXTENSION_URL = 'chrome-extension://test-extension-id/';
const ID = '0123456789abcdef0123456789abcdef';

function fakePort(name: string, sender: Runtime.MessageSender) {
  const onDisconnect: (() => void)[] = [];
  const port = {
    name,
    sender,
    disconnect: vi.fn(),
    postMessage: vi.fn(),
    onDisconnect: { addListener: (fn: () => void) => onDisconnect.push(fn) },
    onMessage: { addListener: vi.fn() },
  };
  return {
    port: port as unknown as Runtime.Port,
    close: () => {
      for (const fn of onDisconnect) fn();
    },
  };
}

function setup() {
  const grants = new RepromptGrants();
  let listener: ((port: Runtime.Port) => void) | undefined;
  listenForPopups(
    { addListener: (fn) => (listener = fn) },
    grants,
    'test-extension-id',
    EXTENSION_URL,
  );
  return {
    grants,
    connect: (port: Runtime.Port) => {
      listener!(port);
    },
  };
}

describe('re-prompt grants', () => {
  it('lasts while the popup port is open', () => {
    const { grants, connect } = setup();
    const { port, close } = fakePort(POPUP_PORT_PREFIX + ID, {
      id: 'test-extension-id',
      url: `${EXTENSION_URL}popup/index.html`,
    });
    connect(port);
    expect(port.disconnect).not.toHaveBeenCalled();
    expect(grants.has(ID)).toBe(false);
    grants.grant(ID);
    expect(grants.has(ID)).toBe(true);
    close();
    expect(grants.has(ID)).toBe(false);
    grants.grant(ID);
    expect(grants.has(ID)).toBe(false);
  });

  it('refuses ports from content scripts and other extensions', () => {
    const { grants, connect } = setup();
    for (const sender of [
      { id: 'test-extension-id', url: 'https://evil.example/', tab: { id: 1 } },
      { id: 'other-extension', url: 'chrome-extension://other-extension/popup.html' },
    ] as Runtime.MessageSender[]) {
      const { port } = fakePort(POPUP_PORT_PREFIX + ID, sender);
      connect(port);
      expect(port.disconnect).toHaveBeenCalled();
    }
    grants.grant(ID);
    expect(grants.has(ID)).toBe(false);
  });

  it('refuses malformed and reused session ids', () => {
    const { connect } = setup();
    const sender = { id: 'test-extension-id', url: `${EXTENSION_URL}popup/index.html` };
    const bad = fakePort(`${POPUP_PORT_PREFIX}short`, sender);
    connect(bad.port);
    expect(bad.port.disconnect).toHaveBeenCalled();
    const first = fakePort(POPUP_PORT_PREFIX + ID, sender);
    connect(first.port);
    const second = fakePort(POPUP_PORT_PREFIX + ID, sender);
    connect(second.port);
    expect(first.port.disconnect).not.toHaveBeenCalled();
    expect(second.port.disconnect).toHaveBeenCalled();
  });

  it('ends every grant on lock', () => {
    const grants = new RepromptGrants();
    grants.connect(ID);
    grants.grant(ID);
    grants.revokeAll();
    expect(grants.has(ID)).toBe(false);
    expect(grants.has(undefined)).toBe(false);
  });
});

describe('popup session', () => {
  it('opens a port named with a random id and sends the id with re-prompt requests', () => {
    vi.useFakeTimers();
    try {
      let onDisconnect: (() => void) | undefined;
      const postMessage = vi.fn();
      vi.mocked(browser.runtime.connect).mockImplementation(
        ({ name }: { name?: string } = {}) =>
          ({
            name,
            postMessage,
            onDisconnect: { addListener: (fn: () => void) => (onDisconnect = fn) },
            onMessage: { addListener: vi.fn() },
          }) as unknown as Runtime.Port,
      );
      startPopupSession();
      const id = popupSession()!;
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(browser.runtime.connect).toHaveBeenCalledWith({ name: POPUP_PORT_PREFIX + id });
      expect(pw(undefined)).toEqual({ session: id });
      expect(pw({ masterPassword: 'secret' })).toEqual({ session: id, masterPassword: 'secret' });
      expect(pw({ pin: '2468' })).toEqual({ session: id, pin: '2468' });
      // Keeps the worker awake while the popup is open.
      vi.advanceTimersByTime(20_000);
      expect(postMessage).toHaveBeenCalled();
      // The worker went away: the old session is gone, and a new one opens.
      onDisconnect!();
      expect(popupSession()).toBeUndefined();
      vi.advanceTimersByTime(500);
      expect(popupSession()).toMatch(/^[0-9a-f]{32}$/);
      expect(popupSession()).not.toBe(id);
    } finally {
      vi.useRealTimers();
    }
  });
});
