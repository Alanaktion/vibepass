/**
 * Quick find: an in-memory MiniSearch index over decrypted summaries, built at unlock and
 * rebuilt on sync. Fuzzy and prefix matching on name, username, website, and notes. Items saved
 * for the current page come first, ranked by how closely their URIs match it.
 *
 * The index lives only in the background worker and is cleared on lock.
 */
import MiniSearch from 'minisearch';
import { clearMatchCache, matchScore, parseUri, savedDomain } from '../vault/match';
import { sharedCredentialDomains } from '../vault/site-data';
import type { CipherSummary, CipherType, SearchHit } from '../vault/types';

export interface SearchOptions {
  /** The page the user is on; its matches rank first. */
  url?: string;
  /**
   * Item types the page has a form for (cards on a checkout page). With no query, they come
   * first, as suggestions for the form.
   */
  formTypes?: readonly CipherType[];
  limit?: number;
}

export interface SearchIndex {
  replaceAll(
    items: readonly CipherSummary[],
    notes?: ReadonlyMap<string, string>,
    groups?: unknown,
  ): void;
  search(query: string, options?: SearchOptions): SearchHit[];
  /** Items saved for a page, best match first. Used by autofill. */
  matchesFor(url: string, includeEquivalents?: boolean): SearchHit[];
  /** Every item of a type, favorites first, then by name. Cards and identities for autofill. */
  ofType(type: CipherType): CipherSummary[];
  pageFor(url: string): ReturnType<typeof parseUri>;
  clear(): void;
}

interface Doc {
  id: string;
  name: string;
  username: string;
  hosts: string;
  notes: string;
}

/** Split on anything that isn't a letter or digit, so "login.example.com" is three terms. */
const tokenize = (text: string): string[] => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function hostsOf(item: CipherSummary): string {
  const hosts = new Set<string>();
  for (const { uri } of item.uris) {
    const parsed = parseUri(uri);
    hosts.add(parsed ? parsed.url.hostname.replace(/^www\./, '') : uri);
  }
  return [...hosts].join(' ');
}

function createMiniSearch(): MiniSearch<Doc> {
  return new MiniSearch<Doc>({
    fields: ['name', 'username', 'hosts', 'notes'],
    storeFields: [],
    tokenize,
    processTerm: (term) => term.toLowerCase(),
    searchOptions: {
      boost: { name: 3, username: 1.5, hosts: 2, notes: 0.3 },
      prefix: true,
      // Fuzzy only on longer terms, so short prefixes stay precise.
      fuzzy: (term) => (term.length > 3 ? 0.2 : false),
      combineWith: 'AND',
    },
  });
}

const DEFAULT_LIMIT = 50;

export function createSearchIndex(): SearchIndex {
  let mini = createMiniSearch();
  let byId = new Map<string, CipherSummary>();
  let ordered: CipherSummary[] = [];

  let equivalents: Set<string>[] = [];
  function pageFor(url: string) {
    const page = parseUri(url);
    if (page) {
      // Only groups containing this page count. Overlaps do not imply transitive matches.
      for (const group of equivalents) {
        if (!group.has(page.domain)) continue;
        page.equivalents = page.equivalents ? new Set([...page.equivalents, ...group]) : group;
      }
    }
    return page;
  }

  const rank = (item: CipherSummary, page: ReturnType<typeof parseUri>) =>
    matchScore(item.uris, page);

  /** Below any real match: saved for a site Apple lists as sharing accounts with the page. */
  const SHARED_SITE = 0.5;
  const sharedRank = (item: CipherSummary, page: ReturnType<typeof parseUri>) => {
    if (!page) return 0;
    const shared = sharedCredentialDomains(page.domain);
    if (shared.size === 0) return 0;
    return item.uris.some((uri) => {
      const domain = savedDomain(uri.uri);
      return domain !== null && shared.has(domain);
    })
      ? SHARED_SITE
      : 0;
  };

  return {
    pageFor,
    replaceAll(items, notes, groups) {
      equivalents = [];
      if (Array.isArray(groups)) {
        for (const group of groups) {
          if (!Array.isArray(group)) continue;
          const domains = group
            .filter((d): d is string => typeof d === 'string')
            .map((d) => d.trim().toLowerCase());
          equivalents.push(new Set(domains));
        }
      }
      mini = createMiniSearch();
      byId = new Map(items.map((item) => [item.id, item]));
      ordered = [...items];
      mini.addAll(
        items.map((item) => ({
          id: item.id,
          name: item.name,
          username: item.subtitle ?? '',
          hosts: hostsOf(item),
          notes: notes?.get(item.id) ?? '',
        })),
      );
    },

    search(query, options = {}) {
      const limit = options.limit ?? DEFAULT_LIMIT;
      const page = options.url ? pageFor(options.url) : null;
      const needle = query.trim();

      const formTypes = needle === '' ? (options.formTypes ?? []) : [];
      let scored: { item: CipherSummary; score: number }[];
      if (needle === '') {
        // No query: site matches, then favorites, then everything, alphabetically.
        scored = ordered.map((item) => ({ item, score: item.favorite ? 1 : 0 }));
      } else {
        scored = [];
        for (const result of mini.search(needle)) {
          const item = byId.get(result.id as string);
          if (item) scored.push({ item, score: result.score });
        }
      }

      const ranked = scored.map(({ item, score }) => {
        const site = rank(item, page);
        const form = formTypes.includes(item.type) ? 1 : 0;
        return { item, score, form, site: site > 0 ? site : sharedRank(item, page) };
      });
      // Stable sort: suggestions for the page's form, then site match quality, then relevance
      // (or favorites, with no query).
      ranked.sort((a, b) => b.form - a.form || b.site - a.site || b.score - a.score);
      return ranked.slice(0, limit).map(({ item, site, form }): SearchHit => {
        if (form) return { ...item, siteMatch: false, formMatch: true };
        return site === SHARED_SITE
          ? { ...item, siteMatch: false, sharedSite: true }
          : { ...item, siteMatch: site > 0 };
      });
    },

    matchesFor(url, includeEquivalents = false) {
      const page = includeEquivalents ? pageFor(url) : parseUri(url);
      if (!page) return [];
      return ordered
        .map((item) => ({ item, site: rank(item, page) }))
        .filter(({ site }) => site > 0)
        .sort((a, b) => b.site - a.site)
        .map(({ item }) => ({ ...item, siteMatch: true }));
    },

    ofType(type) {
      return ordered
        .filter((item) => item.type === type)
        .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
    },

    clear() {
      equivalents = [];
      clearMatchCache();
      mini = createMiniSearch();
      byId = new Map();
      ordered = [];
    },
  };
}
