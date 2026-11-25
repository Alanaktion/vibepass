import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';
import { App } from '../src/popup/App';
import type { Envelope, Message, MessageType, VaultStatus } from '../src/shared/messages';
import { DEFAULT_SETTINGS } from '../src/storage/settings';
import { CipherType, type CipherDetail, type SearchHit } from '../src/vault/types';

const base: VaultStatus = {
  state: 'unlocked',
  serverUrl: 'https://vault.example.com',
  email: 'me@example.com',
  lastSync: '2026-11-25T00:00:00.000Z',
  itemCount: 2,
  syncError: null,
};

const hit = (id: string, name: string, siteMatch: boolean): SearchHit => ({
  id,
  type: CipherType.Login,
  name,
  subtitle: `${id}@example.com`,
  uris: [{ uri: siteMatch ? 'https://login.example.com' : 'https://other.test', match: null }],
  favorite: false,
  folderId: null,
  organizationId: null,
  collectionIds: [],
  hasTotp: false,
  reprompt: false,
  siteMatch,
});

const detail: CipherDetail = {
  id: 'a',
  type: CipherType.Login,
  name: 'Example Login',
  favorite: false,
  folder: 'Work',
  organization: null,
  collections: [],
  uris: [{ uri: 'https://login.example.com', match: null }],
  sections: [
    {
      title: null,
      fields: [
        { id: 'login.username', label: 'Username', kind: 'text', value: 'alice', canReveal: true },
        {
          id: 'login.password',
          label: 'Password',
          kind: 'concealed',
          value: null,
          canReveal: true,
        },
      ],
    },
  ],
  notes: 'hello notes',
  attachments: [],
  hasTotp: false,
  reprompt: false,
  revisionDate: '2026-11-25T00:00:00.000Z',
};

type Responder = (payload: unknown) => Envelope<unknown>;

function backend(status: VaultStatus, overrides: Partial<Record<MessageType, Responder>> = {}) {
  const calls: Message[] = [];
  const defaults: Partial<Record<MessageType, Responder>> = {
    'vault:status': () => ({ ok: true, data: status }),
    'settings:get': () => ({ ok: true, data: DEFAULT_SETTINGS }),
    'vault:search': () => ({
      ok: true,
      data: [hit('a', 'Example Login', true), hit('b', 'Other', false)],
    }),
    'vault:item': () => ({ ok: true, data: detail }),
    'vault:reveal': () => ({ ok: true, data: 'hunter2' }),
    'autofill:fill': () => ({
      ok: true,
      data: { filled: ['username', 'password'], copiedTotp: false },
    }),
    'clipboard:copied': () => ({ ok: true, data: undefined }),
  };
  vi.mocked(browser.runtime.sendMessage).mockImplementation(((message: Message) => {
    calls.push(message);
    const responder = overrides[message.type] ?? defaults[message.type];
    return Promise.resolve(
      responder ? responder(message.payload) : { ok: false, error: 'unmocked' },
    );
  }) as never);
  return calls;
}

describe('popup', () => {
  beforeEach(() => {
    vi.mocked(browser.runtime.sendMessage).mockReset();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.resolve()) },
    });
    window.close = vi.fn();
  });

  it('shows setup when logged out', async () => {
    backend({ ...base, state: 'logged-out', serverUrl: null, email: null, itemCount: 0 });
    render(<App />);
    expect(await screen.findByLabelText('Server URL')).toBeTruthy();
  });

  it('shows the lock screen when locked', async () => {
    backend({ ...base, state: 'locked', itemCount: 0 });
    render(<App />);
    expect(await screen.findByLabelText('Master password')).toBeTruthy();
    expect(screen.getByText('me@example.com')).toBeTruthy();
  });

  it('lists site matches first and fills the selected item on Enter', async () => {
    const calls = backend(base);
    render(<App />);
    expect(await screen.findByText('Suggested for login.example.com')).toBeTruthy();
    expect(screen.getByText('All items')).toBeTruthy();
    const search = screen.getByLabelText('Search vault');
    await waitFor(() => {
      expect(
        calls.some((c) => c.type === 'vault:search' && (c.payload as { url?: string }).url),
      ).toBe(true);
    });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => {
      expect(calls.find((c) => c.type === 'autofill:fill')?.payload).toMatchObject({
        tabId: 7,
        id: 'a',
      });
    });
    await waitFor(() => {
      expect(window.close).toHaveBeenCalled();
    });
  });

  it('moves the selection with the arrow keys and copies the password with a chord', async () => {
    const calls = backend(base);
    render(<App />);
    await screen.findByText('Other');
    const search = screen.getByLabelText('Search vault');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(
        screen.getByText('Other').closest('[role=option]')?.getAttribute('aria-selected'),
      ).toBe('true');
    });
    fireEvent.keyDown(search, {
      key: 'c',
      code: 'KeyC',
      ctrlKey: true,
      metaKey: true,
      shiftKey: true,
    });
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hunter2');
    });
    expect(calls.find((c) => c.type === 'vault:reveal')?.payload).toMatchObject({ id: 'b' });
    await waitFor(() => {
      expect(calls.some((c) => c.type === 'clipboard:copied')).toBe(true);
    });
    expect(await screen.findByText(/Password copied · clears in 30s/)).toBeTruthy();
  });

  it('opens an item with secrets masked until revealed', async () => {
    backend(base);
    render(<App />);
    fireEvent.click(await screen.findByText('Example Login'));
    expect(await screen.findByText('alice')).toBeTruthy();
    expect(screen.getByText('hello notes')).toBeTruthy();
    expect(screen.queryByText('hunter2')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal Password' }));
    expect(await screen.findByText('hunter2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide Password' }));
    expect(screen.queryByText('hunter2')).toBeNull();
  });

  it('copies the masked value directly while keeping it concealed', async () => {
    const calls = backend(base);
    render(<App />);
    fireEvent.click(await screen.findByText('Example Login'));
    const masked = await screen.findByRole('button', { name: 'Copy Password (masked)' });
    expect(calls.some((c) => c.type === 'vault:reveal')).toBe(false);
    fireEvent.click(masked);
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hunter2');
      expect(calls.some((c) => c.type === 'clipboard:copied')).toBe(true);
    });
    expect(calls.find((c) => c.type === 'vault:reveal')?.payload).toEqual({
      id: 'a',
      fieldId: 'login.password',
    });
    expect(screen.queryByText('hunter2')).toBeNull();
    expect((await screen.findByRole('status')).textContent).toBe('Password copied · clears in 30s');
  });

  it('keeps organization-restricted masked values unavailable to copy', async () => {
    const calls = backend(base, {
      'vault:item': () => ({
        ok: true,
        data: {
          ...detail,
          sections: [
            {
              title: null,
              fields: [
                {
                  id: 'login.password',
                  label: 'Password',
                  kind: 'concealed',
                  value: null,
                  canReveal: false,
                },
              ],
            },
          ],
        },
      }),
    });
    render(<App />);
    fireEvent.click(await screen.findByText('Example Login'));
    await screen.findByText('Hidden by your organization');
    fireEvent.click(screen.getByText('••••••••••'));
    expect(screen.queryByRole('button', { name: /^(Copy|Reveal) Password/ })).toBeNull();
    expect(calls.some((c) => c.type === 'vault:reveal')).toBe(false);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('asks for the master password on re-prompt items', async () => {
    let attempts = 0;
    const calls = backend(base, {
      'vault:reveal': (payload) => {
        attempts++;
        return (payload as { masterPassword?: string }).masterPassword === 'pw'
          ? { ok: true, data: 'hunter2' }
          : { ok: false, error: 'Enter your master password', code: 'reprompt-required' };
      },
    });
    render(<App />);
    fireEvent.click(await screen.findByText('Example Login'));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy Password (masked)' }));
    const input = await screen.findByLabelText('Master password');
    fireEvent.input(input, { target: { value: 'pw' } });
    fireEvent.click(screen.getByText('Continue'));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hunter2');
    });
    expect(screen.queryByText('hunter2')).toBeNull();
    expect(attempts).toBe(2);
    expect(calls.filter((c) => c.type === 'vault:reveal')).toHaveLength(2);
  });

  it('asks before filling an item not saved for the page', async () => {
    let forced = false;
    backend(base, {
      'autofill:fill': (payload) => {
        if ((payload as { force?: boolean }).force) {
          forced = true;
          return { ok: true, data: { filled: ['password'], copiedTotp: false } };
        }
        return {
          ok: false,
          error: '“Other” isn’t saved for login.example.com',
          code: 'fill-mismatch',
        };
      },
    });
    render(<App />);
    await screen.findByText('Other');
    fireEvent.keyDown(screen.getByLabelText('Search vault'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByLabelText('Search vault'), { key: 'Enter' });
    fireEvent.click(await screen.findByText('Fill anyway'));
    await waitFor(() => {
      expect(forced).toBe(true);
    });
  });

  it('switches to the lock screen when the worker locks', async () => {
    backend(base);
    render(<App />);
    await screen.findByLabelText('Search vault');
    const listener = vi.mocked(browser.runtime.onMessage.addListener).mock.calls.at(-1)![0] as (
      m: unknown,
    ) => void;
    listener({ source: 'vibepass', type: 'event:status', payload: { ...base, state: 'locked' } });
    expect(await screen.findByRole('heading', { name: 'Unlock' })).toBeTruthy();
  });

  it('asks for a two-step code after the password', async () => {
    const calls = backend(
      { ...base, state: 'logged-out', serverUrl: null, email: null, itemCount: 0 },
      {
        'vault:login': (payload) =>
          (payload as { challenge?: unknown }).challenge
            ? { ok: true, data: base }
            : {
                ok: false,
                error: 'Enter your two-step login code',
                code: 'two-factor-required',
                details: { providers: [0], emailHint: null },
              },
      },
    );
    render(<App />);
    fireEvent.input(await screen.findByLabelText('Server URL'), {
      target: { value: 'https://vault.example.com' },
    });
    fireEvent.input(screen.getByLabelText('Email'), { target: { value: 'me@example.com' } });
    fireEvent.input(screen.getByLabelText('Master password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByText('Log in'));
    expect(await screen.findByText('Two-step login')).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByText('Continue'));
    await waitFor(() => {
      expect(calls.filter((c) => c.type === 'vault:login').at(-1)?.payload).toMatchObject({
        masterPassword: 'pw',
        challenge: { twoFactor: { provider: 0, token: '123456', remember: true } },
      });
    });
    expect(await screen.findByLabelText('Search vault')).toBeTruthy();
  });
});
