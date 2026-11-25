import { describe, expect, it } from 'vitest';
import { createManifest } from '../scripts/manifest.mjs';

describe('manifest', () => {
  it('uses a service worker on Chrome', () => {
    const manifest = createManifest('chrome', { version: '1.2.3' });
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.version).toBe('1.2.3');
    expect(manifest.background).toEqual({ service_worker: 'background.js', type: 'module' });
    expect(manifest.browser_specific_settings).toBeUndefined();
  });

  it('uses background scripts and a gecko id on Firefox', () => {
    const manifest = createManifest('firefox', { version: '1.2.3' });
    expect(manifest.background).toEqual({ scripts: ['background.js'], type: 'module' });
    expect(manifest.browser_specific_settings).toMatchObject({ gecko: { id: expect.any(String) } });
  });

  it('requests no broad host permissions up front', () => {
    const manifest = createManifest('chrome', { version: '0.0.1' });
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.permissions).toEqual([
      'storage',
      'alarms',
      'activeTab',
      'idle',
      'clipboardWrite',
      'scripting',
      'offscreen',
    ]);
    expect(createManifest('firefox', { version: '0.0.1' }).permissions).not.toContain('offscreen');
    expect(manifest.commands).toHaveProperty('fill-login');
  });
});
