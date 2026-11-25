import { vi } from 'vitest';

/**
 * The real polyfill throws outside an extension context, so tests get a small in-memory fake.
 * Override `sendMessage` per test with vi.mocked(browser.runtime.sendMessage).
 */
vi.mock('webextension-polyfill', () => {
  const store = new Map<string, unknown>();
  const area = (map: Map<string, unknown>) => ({
    get: vi.fn((key: string) => Promise.resolve(map.has(key) ? { [key]: map.get(key) } : {})),
    set: vi.fn((items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) map.set(k, v);
      return Promise.resolve();
    }),
    remove: vi.fn((key: string) => {
      map.delete(key);
      return Promise.resolve();
    }),
  });
  return {
    default: {
      runtime: {
        id: 'test-extension-id',
        getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
        sendMessage: vi.fn(),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
        onInstalled: { addListener: vi.fn() },
      },
      storage: { local: area(store), session: area(new Map<string, unknown>()) },
      permissions: {
        request: vi.fn(() => Promise.resolve(true)),
        contains: vi.fn(() => Promise.resolve(false)),
      },
      privacy: {
        services: {
          passwordSavingEnabled: {
            get: vi.fn(() =>
              Promise.resolve({ value: true, levelOfControl: 'controllable_by_this_extension' }),
            ),
            set: vi.fn(() => Promise.resolve()),
            clear: vi.fn(() => Promise.resolve()),
          },
        },
      },
      tabs: {
        query: vi.fn(() =>
          Promise.resolve([{ id: 7, url: 'https://login.example.com/signin', active: true }]),
        ),
      },
      alarms: { onAlarm: { addListener: vi.fn() } },
      commands: { onCommand: { addListener: vi.fn() } },
    },
  };
});
