/**
 * URI helpers without the public suffix list, so the popup stays small. Matching lives in
 * match.ts (worker only).
 */
import type { LoginUri } from './types';

/** Parse a saved URI as a web URL. Saved URIs often lack a scheme ("example.com"). */
export function toWebUrl(value: string): URL | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/** Hostname to show for an item (and to fetch its icon), from its first web URI. */
export function displayHost(uris: readonly LoginUri[]): string | null {
  for (const uri of uris) {
    const url = toWebUrl(uri.uri);
    if (url) return url.hostname;
  }
  return null;
}
