import { describe, expect, it } from 'vitest';
import { generateForRules } from '../src/crypto/generator';
import { DEFAULT_PASSWORD } from '../src/crypto/generator-options';
import { createSearchIndex } from '../src/search';
import { passwordRulesFor, sharedCredentialDomains } from '../src/vault/site-data';
import { CipherType, type CipherSummary } from '../src/vault/types';

const login = (id: string, uri: string): CipherSummary => ({
  id,
  type: CipherType.Login,
  name: id,
  subtitle: null,
  uris: [{ uri, match: null }],
  favorite: false,
  folderId: null,
  organizationId: null,
  collectionIds: [],
  hasTotp: false,
  reprompt: false,
});

describe('Apple password rules', () => {
  it('finds rules by hostname or the nearest listed parent', () => {
    expect(passwordRulesFor('https://163.com/reg')).toBe('minlength: 6; maxlength: 16;');
    expect(passwordRulesFor('https://reg.163.com/signup')).toBe('minlength: 6; maxlength: 16;');
    expect(passwordRulesFor('https://unlisted.example/')).toBeNull();
    expect(passwordRulesFor('not a url')).toBeNull();
  });

  it('makes the generator respect a listed site’s limits', async () => {
    const rules = passwordRulesFor('https://163.com/')!;
    const password = await generateForRules(rules, { kind: 'password', ...DEFAULT_PASSWORD });
    expect(password.length).toBeGreaterThanOrEqual(6);
    expect(password.length).toBeLessThanOrEqual(16);
  });
});

describe('Apple shared credentials', () => {
  it('links every site in a shared group, and old domains to new ones only', () => {
    expect(sharedCredentialDomains('themeforest.net').has('envato.com')).toBe(true);
    expect(sharedCredentialDomains('envato.com').has('themeforest.net')).toBe(true);
    expect(sharedCredentialDomains('wellfound.com').has('angel.co')).toBe(true);
    expect(sharedCredentialDomains('angel.co').has('wellfound.com')).toBe(false);
    expect(sharedCredentialDomains('example.com').size).toBe(0);
  });

  it('suggests them in quick find below real matches, but never as autofill matches', () => {
    const index = createSearchIndex();
    index.replaceAll([
      login('other', 'https://other.example'),
      login('envato', 'https://account.envato.com'),
      login('theme', 'https://themeforest.net'),
    ]);
    const hits = index.search('', { url: 'https://themeforest.net/sign_in' });
    expect(hits.map((h) => [h.id, h.siteMatch, h.sharedSite ?? false])).toEqual([
      ['theme', true, false],
      ['envato', false, true],
      ['other', false, false],
    ]);
    expect(index.matchesFor('https://themeforest.net/sign_in', true).map((h) => h.id)).toEqual([
      'theme',
    ]);
  });
});
