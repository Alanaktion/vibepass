import { render, screen } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';
import { App } from '../src/popup/App';
import type { VaultStatus } from '../src/shared/messages';

function mockStatus(status: VaultStatus) {
  vi.mocked(browser.runtime.sendMessage).mockResolvedValue({ ok: true, data: status });
}

describe('popup', () => {
  it('shows setup when logged out', async () => {
    mockStatus({ state: 'logged-out', serverUrl: null, email: null, lastSync: null, itemCount: 0 });
    render(<App />);
    expect(await screen.findByLabelText('Server URL')).toBeTruthy();
  });

  it('shows the lock screen when locked', async () => {
    mockStatus({
      state: 'locked',
      serverUrl: 'https://vault.example.com',
      email: 'me@example.com',
      lastSync: null,
      itemCount: 0,
    });
    render(<App />);
    expect(await screen.findByLabelText('Master password')).toBeTruthy();
    expect(screen.getByText('me@example.com')).toBeTruthy();
  });
});
