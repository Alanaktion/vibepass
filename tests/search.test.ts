import { describe, expect, it } from 'vitest';
import { createSearchIndex } from '../src/search';
import { CipherType, type CipherSummary } from '../src/vault/types';

const item = (
  id: string,
  name: string,
  uri: string,
  extra: Partial<CipherSummary> = {},
): CipherSummary => ({
  id,
  type: CipherType.Login,
  name,
  subtitle: null,
  uris: uri ? [{ uri, match: null }] : [],
  favorite: false,
  folderId: null,
  organizationId: null,
  collectionIds: [],
  hasTotp: false,
  reprompt: false,
  ...extra,
});

describe('quick find', () => {
  const items = [
    item('1', 'GitHub', 'https://github.com', { subtitle: 'octocat' }),
    item('2', 'Bank of Example', 'https://bank.example.com'),
    item('3', 'Example Mail', 'https://mail.example.com', { subtitle: 'me@example.com' }),
    item('4', 'Wi-Fi', '', { type: CipherType.SecureNote, favorite: true }),
  ];

  it('matches name, username, and website by prefix, case-insensitively', () => {
    const index = createSearchIndex();
    index.replaceAll(items);
    expect(index.search('git').map((i) => i.id)).toEqual(['1']);
    expect(index.search('OCTO').map((i) => i.id)).toEqual(['1']);
    expect(index.search('bank.example').map((i) => i.id)).toEqual(['2']);
  });

  it('tolerates typos in longer terms', () => {
    const index = createSearchIndex();
    index.replaceAll(items);
    expect(index.search('githib').map((i) => i.id)).toContain('1');
  });

  it('searches notes without returning them', () => {
    const index = createSearchIndex();
    index.replaceAll(items, new Map([['4', 'router password on the fridge']]));
    const hits = index.search('fridge');
    expect(hits.map((i) => i.id)).toEqual(['4']);
    expect(JSON.stringify(hits)).not.toContain('fridge');
  });

  it('puts items for the current site first', () => {
    const index = createSearchIndex();
    index.replaceAll(items);
    const all = index.search('', { url: 'https://mail.example.com/inbox' });
    // Exact host first, then same domain, then the rest (favorites first).
    expect(all.map((i) => i.id)).toEqual(['3', '2', '4', '1']);
    expect(all.map((i) => i.siteMatch)).toEqual([true, true, false, false]);

    const typed = index.search('example', { url: 'https://bank.example.com/' });
    expect(typed[0]!.id).toBe('2');
  });

  it('ranks the most specific domain match first', () => {
    const index = createSearchIndex();
    index.replaceAll([
      item('jkl', 'Jkl', 'https://jkl.example.com'),
      item('root', 'Root', 'https://example.com'),
      item('asdf', 'Asdf', 'https://asdf.example.com'),
      item('deep', 'Deep', 'https://x.asdf.example.com'),
      item('other', 'Other', 'https://other.test'),
    ]);
    const url = 'https://asdf.example.com/login';
    expect(index.search('', { url }).map((i) => i.id)).toEqual([
      'asdf',
      'root',
      'deep',
      'jkl',
      'other',
    ]);
    expect(index.matchesFor(url).map((i) => i.id)).toEqual(['asdf', 'root', 'deep', 'jkl']);
  });

  it('finds autofill matches for a page, best first', () => {
    const index = createSearchIndex();
    index.replaceAll(items);
    expect(index.matchesFor('https://mail.example.com/').map((i) => i.id)).toEqual(['3', '2']);
    expect(index.matchesFor('https://evil.test/')).toEqual([]);
  });

  it('forgets everything on clear', () => {
    const index = createSearchIndex();
    index.replaceAll(items);
    index.clear();
    expect(index.search('')).toEqual([]);
  });

  it('answers in under 100 ms on a 5,000-item vault', () => {
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
    const big: CipherSummary[] = [];
    for (let i = 0; i < 5000; i++) {
      const word = words[i % words.length]!;
      big.push(
        item(
          String(i),
          `${word} account ${String(i)}`,
          `https://${word}${String(i % 700)}.example${String(i % 13)}.com/login`,
          {
            subtitle: `user${String(i)}@${word}.test`,
          },
        ),
      );
    }
    const index = createSearchIndex();
    const built = performance.now();
    index.replaceAll(big);
    const buildMs = performance.now() - built;

    const queries = ['', 'a', 'al', 'alpha', 'charli', 'user12', 'delta 4', 'example3', 'xyz'];
    const url = 'https://alpha14.example1.com/login';
    // Warm up once, as the popup's first keystroke would after unlock.
    index.search('warm', { url });
    let worst = 0;
    for (const query of queries) {
      const start = performance.now();
      index.search(query, { url });
      worst = Math.max(worst, performance.now() - start);
    }
    console.info(
      `search benchmark: build ${buildMs.toFixed(0)} ms, worst query ${worst.toFixed(1)} ms`,
    );
    expect(worst).toBeLessThan(100);
    expect(buildMs).toBeLessThan(2000);
  });
});
