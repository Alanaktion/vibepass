import { afterEach, expect, it, vi } from 'vitest';
import pages from './fixtures/autofill-pages.json';
import { detectLoginFields, isNewPasswordField, readSubmitted } from '../src/content/detect';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it.each(pages)('detects the sanitized form at $url', (page) => {
  vi.spyOn(document, 'location', 'get').mockReturnValue(new URL(page.url) as unknown as Location);
  document.body.innerHTML = page.html;
  const fields = detectLoginFields();
  expect(fields.username?.id ?? null).toBe(page.username);
  expect(fields.password?.id ?? null).toBe(page.password);
  expect(fields.totp?.id ?? null).toBe('totp' in page ? page.totp : null);
  const fresh = Array.from(document.querySelectorAll('input')).filter(isNewPasswordField);
  expect(fresh.map((input) => input.id)).toEqual(page.newPassword ? [page.newPassword] : []);
  if (fresh[0]) {
    fresh[0].value = 'generated';
    expect(readSubmitted(document)).toMatchObject({ password: null, newPassword: 'generated' });
  }
});
