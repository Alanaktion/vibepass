import { describe, expect, it, vi } from 'vitest';
import {
  createAutoLock,
  idleIntervalSeconds,
  shouldLock,
  type IdleState,
} from '../src/background/autolock';
import { CLIPBOARD_ALARM, createClipboard } from '../src/background/clipboard';
import { DEFAULT_SETTINGS } from '../src/storage/settings';

function clipboardHarness(seconds = 30) {
  let now = 1_000_000;
  const store = new Map<string, unknown>();
  const timers: { fn: () => void; ms: number }[] = [];
  const writes: string[] = [];
  const alarms = { create: vi.fn(), clear: vi.fn() };
  const clipboard = createClipboard({
    write: (text) => {
      writes.push(text);
      return Promise.resolve();
    },
    clearAfterSeconds: () => Promise.resolve(seconds),
    now: () => now,
    alarms,
    store: {
      get: (key) => Promise.resolve(store.has(key) ? { [key]: store.get(key) } : {}),
      set: (items) => {
        for (const [k, v] of Object.entries(items)) store.set(k, v);
        return Promise.resolve();
      },
      remove: (key) => {
        store.delete(key);
        return Promise.resolve();
      },
    },
    setTimer: (fn, ms) => timers.push({ fn, ms }),
  });
  return { clipboard, writes, alarms, timers, store, advance: (ms: number) => (now += ms) };
}

describe('clipboard clearing', () => {
  it('clears after the configured delay, backed by an alarm', async () => {
    const h = clipboardHarness(20);
    await h.clipboard.copy('hunter2');
    expect(h.writes).toEqual(['hunter2']);
    expect(h.timers[0]?.ms).toBe(20_000);
    // Alarms can't fire sooner than 30 s.
    expect(h.alarms.create).toHaveBeenCalledWith(CLIPBOARD_ALARM, { when: 1_000_000 + 30_000 });

    expect(await h.clipboard.clearIfDue()).toBe(false);
    h.advance(20_000);
    expect(await h.clipboard.clearIfDue()).toBe(true);
    expect(h.writes).toEqual(['hunter2', '']);
    // The alarm firing later finds nothing to do.
    expect(await h.clipboard.clearIfDue()).toBe(false);
  });

  it('survives a worker restart, because the deadline is stored', async () => {
    const h = clipboardHarness(60);
    await h.clipboard.scheduleClear();
    h.advance(61_000);
    expect(await h.clipboard.clearIfDue()).toBe(true);
    expect(h.writes).toEqual(['']);
  });

  it('does nothing when clearing is off', async () => {
    const h = clipboardHarness(0);
    await h.clipboard.copy('x');
    expect(h.timers).toEqual([]);
    expect(h.store.size).toBe(0);
  });
});

describe('auto-lock', () => {
  it('maps settings to an idle interval', () => {
    expect(idleIntervalSeconds({ ...DEFAULT_SETTINGS, lockAfterMinutes: 15 })).toBe(900);
    expect(idleIntervalSeconds({ ...DEFAULT_SETTINGS, lockAfterMinutes: 0 })).toBeGreaterThan(900);
  });

  it('locks on idle and on system lock, as configured', () => {
    const on = DEFAULT_SETTINGS;
    expect(shouldLock('idle', on)).toBe(true);
    expect(shouldLock('locked', on)).toBe(true);
    expect(shouldLock('active', on)).toBe(false);
    const off = { ...on, lockAfterMinutes: 0, lockOnSystemLock: false };
    expect(shouldLock('idle', off)).toBe(false);
    expect(shouldLock('locked', off)).toBe(false);
  });

  it('locks the vault when the idle state changes', async () => {
    let listener: ((state: IdleState) => void) | undefined;
    const lock = vi.fn(() => Promise.resolve());
    const alarms = { create: vi.fn(), clear: vi.fn() };
    const setDetectionInterval = vi.fn();
    const settings = { ...DEFAULT_SETTINGS, lockOnSystemLock: false, lockAfterMinutes: 5 };
    const autoLock = createAutoLock({
      idle: { setDetectionInterval, onStateChanged: { addListener: (fn) => (listener = fn) } },
      settings: () => Promise.resolve(settings),
      lock,
      alarms,
    });
    autoLock.listen();
    await autoLock.apply();
    expect(setDetectionInterval).toHaveBeenCalledWith(300);

    // Screen locked but "lock on system lock" is off: keep the idle timeout with an alarm.
    listener!('locked');
    await vi.waitFor(() => {
      expect(alarms.create).toHaveBeenCalledWith('vibepass:auto-lock', { delayInMinutes: 5 });
    });
    expect(lock).not.toHaveBeenCalled();

    listener!('idle');
    await vi.waitFor(() => {
      expect(lock).toHaveBeenCalledTimes(1);
    });
  });
});
