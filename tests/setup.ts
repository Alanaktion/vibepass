import { vi } from 'vitest';

/**
 * The real polyfill throws outside an extension context, so tests get a small in-memory fake.
 * Override `sendMessage` per test with vi.mocked(browser.runtime.sendMessage).
 */
vi.mock('webextension-polyfill', () => {
  const store = new Map<string, unknown>();
  return {
    default: {
      runtime: {
        id: 'test-extension-id',
        sendMessage: vi.fn(),
        onMessage: { addListener: vi.fn() },
        onInstalled: { addListener: vi.fn() },
      },
      storage: {
        local: {
          get: vi.fn((key: string) =>
            Promise.resolve(store.has(key) ? { [key]: store.get(key) } : {}),
          ),
          set: vi.fn((items: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(items)) store.set(k, v);
            return Promise.resolve();
          }),
        },
      },
      alarms: { onAlarm: { addListener: vi.fn() } },
      commands: { onCommand: { addListener: vi.fn() } },
    },
  };
});
