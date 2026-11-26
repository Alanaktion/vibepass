/**
 * Clears copied secrets from the clipboard after the configured delay. The popup writes the
 * clipboard itself (it has the user gesture); the worker only schedules and performs the clear,
 * because the popup usually closes long before the timeout.
 *
 * MV3 workers can be stopped at any time, so the deadline is kept in storage.session and backed
 * by an alarm; a timer handles delays shorter than the alarm minimum.
 */
export const CLIPBOARD_ALARM = 'vibepass:clear-clipboard';
const PENDING_KEY = 'clipboardClearAt';

export interface ClipboardDeps {
  /** Write text to the system clipboard (offscreen document in Chrome, background in Firefox). */
  write: (text: string) => Promise<void>;
  clearAfterSeconds: () => Promise<number>;
  now: () => number;
  alarms: {
    create(name: string, info: { when: number }): void | Promise<void>;
    clear(name: string): unknown;
  };
  store: {
    get: (key: string) => Promise<Record<string, unknown>>;
    set: (items: Record<string, unknown>) => Promise<void>;
    remove: (key: string) => Promise<void>;
  };
  setTimer?: (fn: () => void, ms: number) => unknown;
}

export function createClipboard(deps: ClipboardDeps) {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));

  // Timer, alarm and copy events may overlap. Finish each deadline update before the next.
  let pending: Promise<unknown> = Promise.resolve();
  function inOrder<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.catch(() => undefined);
    return result;
  }

  async function pendingAt(): Promise<number | null> {
    const value = (await deps.store.get(PENDING_KEY))[PENDING_KEY];
    return typeof value === 'number' ? value : null;
  }

  /** Clear now if a clear is due. Safe to call from the timer, the alarm, and worker start. */
  async function clearIfDue(): Promise<boolean> {
    const at = await pendingAt();
    if (at === null || deps.now() < at - 500) return false;
    try {
      await deps.write('');
    } catch {
      await deps.alarms.create(CLIPBOARD_ALARM, { when: deps.now() + 30_000 });
      return false;
    }
    await deps.store.remove(PENDING_KEY);
    await deps.alarms.clear(CLIPBOARD_ALARM);
    return true;
  }

  /** Called after something was copied: (re)start the countdown. */
  async function scheduleClear(): Promise<void> {
    const seconds = await deps.clearAfterSeconds();
    if (seconds <= 0) return;
    const at = deps.now() + seconds * 1000;
    await deps.store.set({ [PENDING_KEY]: at });
    // Chrome alarms fire no sooner than 30 s; the timer covers shorter delays while we're awake.
    await deps.alarms.create(CLIPBOARD_ALARM, { when: Math.max(at, deps.now() + 30_000) });
    setTimer(() => void inOrder(clearIfDue), seconds * 1000);
  }

  /** Copy from the worker (the TOTP after a fill), then schedule the clear. */
  async function copy(text: string): Promise<void> {
    await deps.write(text);
    await scheduleClear();
  }

  return {
    copy: (text: string) => inOrder(() => copy(text)),
    scheduleClear: () => inOrder(scheduleClear),
    clearIfDue: () => inOrder(clearIfDue),
  };
}
