// @ts-check
/**
 * Generates manifest.json for each target browser from one source of truth.
 *
 * Differences handled here:
 * - Chrome MV3 uses a background service worker; Firefox MV3 uses background scripts.
 * - Firefox needs browser_specific_settings.gecko (add-on id, minimum version for storage.session).
 */

/** @typedef {'chrome' | 'firefox'} Browser */

/**
 * @param {Browser} browser
 * @param {{ version: string }} pkg
 */
export function createManifest(browser, pkg) {
  /** @type {Record<string, unknown>} */
  const manifest = {
    manifest_version: 3,
    name: 'Vibepass',
    short_name: 'Vibepass',
    description: 'Fast, keyboard-first password manager for self-hosted Bitwarden and Vaultwarden.',
    version: pkg.version,
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    action: {
      default_title: 'Vibepass',
      default_popup: 'popup/index.html',
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
      },
    },
    // Minimal permissions. The server origin is requested at runtime from optional_host_permissions
    // once the user enters their server URL.
    // idle: auto-lock. clipboardWrite: clear copied secrets. scripting: inject the content script
    // into a tab opened before install, only on a fill gesture (activeTab).
    permissions: ['storage', 'alarms', 'activeTab', 'idle', 'clipboardWrite', 'scripting'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    // Asked for only when the user turns off the browser's built-in password manager.
    optional_permissions: ['privacy'],
    content_scripts: [
      {
        matches: ['https://*/*', 'http://*/*'],
        js: ['content.js'],
        run_at: 'document_idle',
        all_frames: false,
      },
    ],
    commands: {
      _execute_action: {
        suggested_key: { default: 'Ctrl+Shift+Space', mac: 'Command+Shift+Space' },
        description: 'Open quick find',
      },
      'fill-login': {
        suggested_key: { default: 'Ctrl+Shift+L', mac: 'Command+Shift+L' },
        description: 'Fill the best login for this page',
      },
    },
    content_security_policy: {
      // 'wasm-unsafe-eval' is required for the Argon2id WASM build. No remote code is ever loaded.
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  };

  if (browser === 'chrome') {
    // Chrome workers have no DOM; an offscreen document clears the clipboard.
    /** @type {string[]} */ (manifest.permissions).push('offscreen');
    manifest.background = { service_worker: 'background.js', type: 'module' };
    manifest.minimum_chrome_version = '116';
  } else {
    manifest.background = { scripts: ['background.js'], type: 'module' };
    manifest.browser_specific_settings = {
      gecko: { id: 'vibepass@vibepass.dev', strict_min_version: '128.0' },
    };
  }

  return manifest;
}
