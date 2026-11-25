/**
 * Auto-lock: on system lock (screen lock or sleep) and after the configured idle time, using
 * the idle API. Closing the browser locks too, because storage.session doesn't survive it.
 */
import type { Settings } from '../storage/settings';

export type IdleState = 'active' | 'idle' | 'locked';

export interface AutoLockDeps {
  idle: {
    setDetectionInterval(seconds: number): void;
    onStateChanged: { addListener(fn: (state: IdleState) => void): void };
  };
  settings(): Promise<Settings>;
  lock(): Promise<unknown>;
  alarms: {
    create(name: string, info: { delayInMinutes: number }): void;
    clear(name: string): unknown;
  };
}

export const AUTO_LOCK_ALARM = 'vibepass:auto-lock';

/** Chrome's idle API accepts 15 s at the least. */
const MIN_INTERVAL_SECONDS = 15;
/** With idle lock off we still listen for system lock, which doesn't depend on the interval. */
const OFF_INTERVAL_SECONDS = 4 * 60 * 60;

export function idleIntervalSeconds(settings: Settings): number {
  return settings.lockAfterMinutes > 0
    ? Math.max(MIN_INTERVAL_SECONDS, Math.round(settings.lockAfterMinutes * 60))
    : OFF_INTERVAL_SECONDS;
}

export function shouldLock(state: IdleState, settings: Settings): boolean {
  if (state === 'locked') return settings.lockOnSystemLock;
  if (state === 'idle') return settings.lockAfterMinutes > 0;
  return false;
}

export function createAutoLock(deps: AutoLockDeps) {
  async function apply(): Promise<void> {
    deps.idle.setDetectionInterval(idleIntervalSeconds(await deps.settings()));
  }

  /** Register synchronously at worker start, so an idle event can wake the worker. */
  function listen(): void {
    deps.idle.onStateChanged.addListener((state) => {
      void deps.settings().then(async (settings) => {
        if (shouldLock(state, settings)) {
          await deps.alarms.clear(AUTO_LOCK_ALARM);
          return deps.lock();
        }
        if (state === 'locked' && settings.lockAfterMinutes > 0) {
          // The idle state can't fire while the screen is locked, so keep the idle timeout
          // with an alarm instead.
          deps.alarms.create(AUTO_LOCK_ALARM, { delayInMinutes: settings.lockAfterMinutes });
        } else if (state === 'active') {
          await deps.alarms.clear(AUTO_LOCK_ALARM);
        }
        return undefined;
      });
    });
  }

  return { apply, listen };
}
