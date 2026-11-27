/**
 * Matching saved login URIs against the page the user is on, with the official clients' match
 * types. Autofill only offers items that match, so this is a security boundary: a lookalike or
 * sibling domain must never match.
 */
import { parse } from 'tldts';
import { UriMatch, type LoginUri } from './types';
import { toWebUrl } from './uri';

export { displayHost } from './uri';

/** How well an item fits a page. Higher is better; None means "not for this page". */
export enum MatchQuality {
  None = 0,
  /** Same registrable domain (login.example.com on www.example.com). */
  Domain = 1,
  /** Same host and port. */
  Host = 2,
  /** Exact URL, URL prefix, or a regular expression the user wrote. */
  Exact = 3,
}

export interface ParsedPage {
  url: URL;
  /** Registrable domain (eTLD+1), or the hostname for IPs, localhost, and intranet names. */
  domain: string;
  port: string;
  equivalents?: ReadonlySet<string> | undefined;
}

/** Parse a page or saved URI. Saved URIs often lack a scheme ("example.com"), as in Bitwarden. */
export function parseUri(value: string): ParsedPage | null {
  const url = toWebUrl(value);
  if (!url) return null;
  const hostname = url.hostname.toLowerCase();
  const info = parse(hostname, { allowPrivateDomains: true });
  const domain = info.isIp || !info.domain ? hostname.replace(/^\[|\]$/g, '') : info.domain;
  return { url, domain, port: effectivePort(url) };
}

/** Saved URIs are parsed once and reused, so ranking thousands of items stays fast. */
const savedCache = new Map<string, ParsedPage | null>();
const SAVED_CACHE_LIMIT = 50_000;

function parseSaved(value: string): ParsedPage | null {
  let parsed = savedCache.get(value);
  if (parsed === undefined) {
    if (savedCache.size >= SAVED_CACHE_LIMIT) savedCache.clear();
    parsed = parseUri(value);
    savedCache.set(value, parsed);
  }
  return parsed;
}

/** Registrable domain of a saved URI, or null when it isn't a web address. */
export function savedDomain(value: string): string | null {
  return parseSaved(value)?.domain ?? null;
}

/** Forget cached URIs (on lock, so no decrypted URI outlives the vault in memory). */
export function clearMatchCache(): void {
  savedCache.clear();
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === 'http:' ? '80' : '443';
}

function hasExplicitPort(value: string): boolean {
  const withoutScheme = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const host = withoutScheme.split(/[/?#]/, 1)[0] ?? '';
  return /:\d+$/.test(host);
}

/** Match one saved URI against a parsed page. */
export function matchUri(saved: LoginUri, page: ParsedPage): MatchQuality {
  const match = saved.match ?? UriMatch.Domain;
  const href = page.url.href;
  switch (match) {
    case UriMatch.Never:
      return MatchQuality.None;
    case UriMatch.Exact:
      return normalizeHref(saved.uri) === href ? MatchQuality.Exact : MatchQuality.None;
    case UriMatch.StartsWith:
      return href.startsWith(normalizeHref(saved.uri)) ? MatchQuality.Exact : MatchQuality.None;
    case UriMatch.RegularExpression:
      try {
        return new RegExp(saved.uri, 'i').test(href) ? MatchQuality.Exact : MatchQuality.None;
      } catch {
        return MatchQuality.None;
      }
    case UriMatch.Host: {
      const parsed = parseSaved(saved.uri);
      if (!parsed) return MatchQuality.None;
      return parsed.url.hostname === page.url.hostname && parsed.port === page.port
        ? MatchQuality.Host
        : MatchQuality.None;
    }
    case UriMatch.Domain: {
      const parsed = parseSaved(saved.uri);
      if (!parsed || (parsed.domain !== page.domain && !page.equivalents?.has(parsed.domain))) {
        return MatchQuality.None;
      }
      // A saved port (vault.example.com:8443) must match; otherwise any port on the domain does.
      if (hasExplicitPort(saved.uri) && parsed.port !== page.port) return MatchQuality.None;
      return parsed.url.hostname === page.url.hostname ? MatchQuality.Host : MatchQuality.Domain;
    }
    default:
      return MatchQuality.None;
  }
}

function normalizeHref(value: string): string {
  return parseSaved(value)?.url.href ?? value;
}

/** Best match of any of an item's URIs for the page. */
export function matchItem(uris: readonly LoginUri[], page: ParsedPage | null): MatchQuality {
  if (!page) return MatchQuality.None;
  let best = MatchQuality.None;
  for (const uri of uris) {
    const quality = matchUri(uri, page);
    if (quality > best) best = quality;
  }
  return best;
}

/**
 * True when filling would send a secret saved for an https site to a plain http page, which a
 * network attacker could read. Autofill refuses this unless the user confirms.
 */
export function isInsecureDowngrade(uris: readonly LoginUri[], page: ParsedPage): boolean {
  if (page.url.protocol !== 'http:') return false;
  const matching = uris.filter((uri) => matchUri(uri, page) !== MatchQuality.None);
  return (
    matching.length > 0 && matching.every((uri) => parseSaved(uri.uri)?.url.protocol !== 'http:')
  );
}

/**
 * Finer ranking for "current site first": match quality, then a parent domain (example.com)
 * over a sibling or deeper subdomain, then how much of the page's hostname the saved URI shares
 * (asdf.example.com beats example.com on asdf.example.com). 0 means no match.
 */
export function matchScore(uris: readonly LoginUri[], page: ParsedPage | null): number {
  if (!page) return 0;
  const pageLabels = page.url.hostname.split('.').reverse();
  let best = 0;
  for (const uri of uris) {
    const quality = matchUri(uri, page);
    if (quality === MatchQuality.None) continue;
    let score = quality * 1000;
    const saved = parseSaved(uri.uri);
    if (saved) {
      const savedLabels = saved.url.hostname.split('.').reverse();
      let shared = 0;
      while (shared < savedLabels.length && savedLabels[shared] === pageLabels[shared]) shared++;
      score += shared * 10;
      // Every label of the saved host matches: it's the page's host or a parent of it, which
      // applies to the page more surely than a sibling or a deeper subdomain does.
      if (shared === savedLabels.length) score += 500;
      if (saved.port === page.port) score += 1;
    }
    if (score > best) best = score;
  }
  return best;
}
