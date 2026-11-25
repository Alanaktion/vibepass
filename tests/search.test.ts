import { describe, expect, it } from 'vitest';
import { createSearchIndex } from '../src/search';
import { CipherType, type CipherSummary } from '../src/vault/types';

const item = (id: string, name: string, uri: string): CipherSummary => ({
  id,
  type: CipherType.Login,
  name,
  subtitle: null,
  uris: [uri],
  favorite: false,
  folderId: null,
});

describe('search index placeholder', () => {
  it('matches name and URL case-insensitively', () => {
    const index = createSearchIndex();
    index.replaceAll([
      item('1', 'GitHub', 'https://github.com'),
      item('2', 'Bank', 'https://bank.test'),
    ]);
    expect(index.search('git').map((i) => i.id)).toEqual(['1']);
    expect(index.search('BANK.test').map((i) => i.id)).toEqual(['2']);
    index.remove('1');
    expect(index.search('git')).toEqual([]);
  });
});
