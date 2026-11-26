import { describe, expect, it } from 'vitest';
import {
  isInsecureDowngrade,
  matchItem,
  MatchQuality,
  matchUri,
  parseUri,
} from '../src/vault/match';
import { UriMatch, type LoginUri } from '../src/vault/types';

const page = (url: string) => parseUri(url)!;
const uri = (value: string, match: UriMatch | null = null): LoginUri => ({ uri: value, match });

describe('URI matching', () => {
  it('matches the registrable domain by default, not lookalikes', () => {
    const saved = uri('https://login.example.com/signin');
    expect(matchUri(saved, page('https://www.example.com/'))).toBe(MatchQuality.Domain);
    expect(matchUri(saved, page('https://login.example.com/other'))).toBe(MatchQuality.Host);
    expect(matchUri(saved, page('https://example.com.evil.test/'))).toBe(MatchQuality.None);
    expect(matchUri(saved, page('https://notexample.com/'))).toBe(MatchQuality.None);
    expect(matchUri(saved, page('https://example.co.uk/'))).toBe(MatchQuality.None);
  });

  it('uses the public suffix list, so sibling sites on shared hosts do not match', () => {
    expect(matchUri(uri('https://alice.github.io'), page('https://bob.github.io'))).toBe(
      MatchQuality.None,
    );
    expect(matchUri(uri('https://shop.example.co.uk'), page('https://www.example.co.uk'))).toBe(
      MatchQuality.Domain,
    );
  });

  it('accepts saved URIs without a scheme', () => {
    expect(matchUri(uri('example.com'), page('https://app.example.com/'))).toBe(
      MatchQuality.Domain,
    );
  });

  it('requires a saved port to match', () => {
    const saved = uri('https://vault.example.com:8443');
    expect(matchUri(saved, page('https://vault.example.com:8443/#/login'))).toBe(MatchQuality.Host);
    expect(matchUri(saved, page('https://vault.example.com/'))).toBe(MatchQuality.None);
    // No saved port: any port on the domain.
    expect(matchUri(uri('https://example.com'), page('https://example.com:444/'))).toBe(
      MatchQuality.Host,
    );
  });

  it('matches IPs and localhost by host', () => {
    expect(matchUri(uri('http://192.168.1.10:8080'), page('http://192.168.1.10:8080/'))).toBe(
      MatchQuality.Host,
    );
    expect(matchUri(uri('http://192.168.1.10'), page('http://192.168.1.11/'))).toBe(
      MatchQuality.None,
    );
    expect(matchUri(uri('http://localhost:3000'), page('http://localhost:3000/login'))).toBe(
      MatchQuality.Host,
    );
  });

  it('honors host, starts-with, exact, regex, and never match types', () => {
    const p = page('https://app.example.com/login?next=1');
    expect(matchUri(uri('https://example.com', UriMatch.Host), p)).toBe(MatchQuality.None);
    expect(matchUri(uri('https://app.example.com', UriMatch.Host), p)).toBe(MatchQuality.Host);
    expect(matchUri(uri('https://app.example.com/login', UriMatch.StartsWith), p)).toBe(
      MatchQuality.Exact,
    );
    expect(matchUri(uri('https://app.example.com/login', UriMatch.Exact), p)).toBe(
      MatchQuality.None,
    );
    expect(matchUri(uri('https://app.example.com/login?next=1', UriMatch.Exact), p)).toBe(
      MatchQuality.Exact,
    );
    expect(matchUri(uri('^https://app\\.example\\.com/', UriMatch.RegularExpression), p)).toBe(
      MatchQuality.Exact,
    );
    expect(matchUri(uri('(', UriMatch.RegularExpression), p)).toBe(MatchQuality.None);
    expect(matchUri(uri('https://app.example.com', UriMatch.Never), p)).toBe(MatchQuality.None);
  });

  it('takes the best match of an item', () => {
    const uris = [
      uri('https://example.com'),
      uri('https://app.example.com/login', UriMatch.StartsWith),
    ];
    expect(matchItem(uris, page('https://app.example.com/login'))).toBe(MatchQuality.Exact);
    expect(matchItem(uris, null)).toBe(MatchQuality.None);
  });

  it('flags filling an https login into an http page', () => {
    expect(isInsecureDowngrade([uri('https://example.com')], page('http://example.com/'))).toBe(
      true,
    );
    expect(isInsecureDowngrade([uri('example.com')], page('http://example.com/'))).toBe(true);
    expect(isInsecureDowngrade([uri('http://example.com')], page('http://example.com/'))).toBe(
      false,
    );
    expect(isInsecureDowngrade([uri('https://example.com')], page('https://example.com/'))).toBe(
      false,
    );
  });

  it('only parses web URLs', () => {
    expect(parseUri('androidapp://com.example')).toBeNull();
    expect(parseUri('')).toBeNull();
  });
});
