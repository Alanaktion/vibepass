// @ts-check
/**
 * Builds the extension for one browser into dist/<browser>/.
 *
 *   node scripts/build.mjs --browser chrome|firefox [--watch]
 *
 * Runs one Vite build per entry because each has a different output format:
 * - popup:      HTML page, ES modules
 * - background: single ES module (service worker in Chrome, module script in Firefox)
 * - content:    single classic scripts (IIFE); content scripts can't be ES modules
 */
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'vite';
import { createManifest } from './manifest.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

const { values } = parseArgs({
  options: {
    browser: { type: 'string', default: 'chrome' },
    watch: { type: 'boolean', default: false },
  },
});

const browser = values.browser;
if (browser !== 'chrome' && browser !== 'firefox') {
  throw new Error(`Unknown --browser "${browser}" (expected chrome or firefox)`);
}
const watch = values.watch ? {} : null;
const mode = values.watch ? 'development' : 'production';
const outDir = `${root}dist/${browser}`;

await rm(outDir, { recursive: true, force: true });

/** @type {import('vite').InlineConfig} */
const shared = {
  configFile: `${root}vite.config.ts`,
  mode,
  logLevel: 'warn',
  publicDir: false,
  define: { __BROWSER__: JSON.stringify(browser) },
  build: {
    outDir,
    emptyOutDir: false,
    sourcemap: mode === 'development' ? 'inline' : false,
    minify: mode === 'production',
    target: browser === 'chrome' ? 'chrome116' : 'firefox128',
    watch,
  },
};

await Promise.all([
  // Popup: root is src/ so the page lands at dist/<browser>/popup/index.html.
  build({
    ...shared,
    root: `${root}src`,
    base: '/',
    publicDir: `${root}public`,
    build: {
      ...shared.build,
      rolldownOptions: {
        input: {
          popup: `${root}src/popup/index.html`,
          offscreen: `${root}src/offscreen/index.html`,
        },
      },
    },
  }),
  build({
    ...shared,
    build: {
      ...shared.build,
      lib: {
        entry: `${root}src/background/index.ts`,
        formats: ['es'],
        fileName: () => 'background.js',
      },
    },
  }),
  ...[
    // Content scripts: login fields and the inline menu (document idle), the passkey prompt
    // (document start), and the page-world stand-in for navigator.credentials (document start).
    { entry: 'src/content/index.ts', name: 'vibepassContent', file: 'content.js' },
    { entry: 'src/content/passkey.ts', name: 'vibepassPasskey', file: 'passkey.js' },
    { entry: 'src/content/webauthn-page.ts', name: 'vibepassWebauthn', file: 'webauthn-page.js' },
  ].map(({ entry, name, file }) =>
    build({
      ...shared,
      build: {
        ...shared.build,
        lib: { entry: `${root}${entry}`, formats: ['iife'], name, fileName: () => file },
      },
    }),
  ),
]);

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- JSON.parse returns any
const pkg = /** @type {{ version: string }} */ (
  JSON.parse(await readFile(`${root}package.json`, 'utf8'))
);
await mkdir(`${outDir}/sdk`, { recursive: true });

// Bitwarden's SDK (GPL-3.0) is loaded at runtime by src/crypto/sdk.ts from sdk/.
const require = createRequire(import.meta.url);
await copyFile(
  require.resolve('@bitwarden/sdk-internal/bitwarden_wasm_internal_bg.wasm'),
  `${outDir}/sdk/bitwarden_wasm_internal_bg.wasm`,
);
await copyFile(`${root}LICENSE`, `${outDir}/LICENSE`);
await copyFile(
  new URL('../../LICENSE', import.meta.resolve('lucide-preact')),
  `${outDir}/LICENSE-LUCIDE`,
);

await writeFile(
  `${outDir}/manifest.json`,
  `${JSON.stringify(createManifest(browser, pkg), null, 2)}\n`,
);

console.log(`Built ${browser} extension into dist/${browser}${values.watch ? ' (watching)' : ''}`);
