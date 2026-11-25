/**
 * Single import point for the WebExtension API.
 *
 * Chrome exposes `chrome.*` with callbacks/promises; Firefox exposes `browser.*` with promises.
 * The polyfill gives us the promise-based `browser.*` API everywhere. Import from here rather
 * than from the polyfill directly so tests can mock one module.
 */
import browser from 'webextension-polyfill';

export default browser;
export type { Runtime, Tabs } from 'webextension-polyfill';
