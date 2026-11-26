import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
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
  version: 1,
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
  folderId: null,
  canEdit: true,
  deletedDate: null,
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
    expect((await screen.findByRole('button', { name: 'Fill' })).textContent).toBe('Fill');
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
    expect(screen.getByRole('button', { name: 'Fill' }).textContent).toBe('Fill');
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
        if (
          (payload as { confirmedOrigin?: string }).confirmedOrigin === 'https://login.example.com'
        ) {
          forced = true;
          return { ok: true, data: { filled: ['password'], copiedTotp: false } };
        }
        return {
          ok: false,
          error: '“Other” isn’t saved for login.example.com',
          code: 'fill-mismatch',
          details: { origin: 'https://login.example.com' },
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

  describe('editing', () => {
    const editing = { ...DEFAULT_SETTINGS, allowEdits: true };
    const editable = {
      id: 'a',
      revisionDate: '2026-11-25T00:00:00.000Z',
      organization: null,
      draft: {
        type: CipherType.Login,
        name: 'Example Login',
        notes: 'hello notes',
        favorite: false,
        folderId: null,
        reprompt: false,
        login: {
          username: 'alice',
          password: 'hunter2',
          totp: '',
          uris: [{ uri: 'https://login.example.com', match: null }],
        },
        fields: [],
      },
    };
    const writeBackend = (overrides: Partial<Record<MessageType, Responder>> = {}) =>
      backend(base, {
        'settings:get': () => ({ ok: true, data: editing }),
        'vault:edit': () => ({ ok: true, data: structuredClone(editable) }),
        'vault:folders': () => ({ ok: true, data: [{ id: 'f1', name: 'Work' }] }),
        'vault:save': () => ({ ok: true, data: { id: 'a' } }),
        ...overrides,
      });

    it('hides editing while it is turned off', async () => {
      backend(base);
      render(<App />);
      fireEvent.click(await screen.findByText('Example Login'));
      await screen.findByText('alice');
      expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'New login' })).toBeNull();
    });

    it('edits an item and saves it with the revision it started from', async () => {
      const calls = writeBackend();
      render(<App />);
      fireEvent.click(await screen.findByText('Example Login'));
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
      const name = await screen.findByLabelText('Name');
      fireEvent.input(name, { target: { value: 'Renamed' } });
      fireEvent.keyDown(document, { key: 's', ctrlKey: true, metaKey: true });
      await waitFor(() => {
        expect(calls.find((c) => c.type === 'vault:save')?.payload).toMatchObject({
          id: 'a',
          revisionDate: editable.revisionDate,
          draft: { name: 'Renamed', login: { password: 'hunter2' } },
        });
      });
      expect(await screen.findByText('Saved')).toBeTruthy();
      // Back on the item view.
      expect(await screen.findByRole('button', { name: 'Edit' })).toBeTruthy();
    });

    it('asks before saving over a change from another device', async () => {
      const calls = writeBackend({
        'vault:save': (payload) =>
          (payload as { overwrite?: boolean }).overwrite
            ? { ok: true, data: { id: 'a' } }
            : { ok: false, error: 'Changed elsewhere', code: 'conflict' },
      });
      render(<App />);
      fireEvent.click(await screen.findByText('Example Login'));
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
      await screen.findByLabelText('Name');
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      fireEvent.click(await screen.findByText('Save mine'));
      await waitFor(() => {
        expect(calls.filter((c) => c.type === 'vault:save').at(-1)?.payload).toMatchObject({
          overwrite: true,
        });
      });
    });

    it('rejects an invalid one-time password key before saving', async () => {
      const calls = writeBackend();
      render(<App />);
      fireEvent.click(await screen.findByText('Example Login'));
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
      fireEvent.input(await screen.findByLabelText('One-time password key'), {
        target: { value: 'not base32 !!' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByText(/one-time password key isn’t valid/)).toBeTruthy();
      expect(calls.some((c) => c.type === 'vault:save')).toBe(false);
    });

    it('starts a new login for the current site and fills in a generated password', async () => {
      const calls = writeBackend({
        'generator:generate': () => ({ ok: true, data: { password: 'Gen3rated-Pass' } }),
        'vault:save': () => ({ ok: true, data: { id: 'new' } }),
      });
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: 'New login' }));
      expect((await screen.findByLabelText<HTMLInputElement>('Name')).value).toBe(
        'login.example.com',
      );
      expect(screen.getByLabelText<HTMLInputElement>('Website 1').value).toBe(
        'https://login.example.com',
      );
      fireEvent.click(screen.getByRole('button', { name: 'Generate a password' }));
      await waitFor(() => {
        expect(screen.getByLabelText<HTMLInputElement>('Password').value).toBe('Gen3rated-Pass');
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(calls.find((c) => c.type === 'vault:save')?.payload).toMatchObject({
          id: null,
          draft: { login: { password: 'Gen3rated-Pass' } },
        });
      });
    });

    it('moves an item to the trash after confirming', async () => {
      const calls = writeBackend({ 'vault:trash-item': () => ({ ok: true, data: undefined }) });
      render(<App />);
      fireEvent.click(await screen.findByText('Example Login'));
      fireEvent.click(await screen.findByRole('button', { name: /Move to trash/ }));
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByText('Move to trash'));
      await waitFor(() => {
        expect(calls.find((c) => c.type === 'vault:trash-item')?.payload).toEqual({ id: 'a' });
      });
      expect(await screen.findByLabelText('Search vault')).toBeTruthy();
    });
  });
});
