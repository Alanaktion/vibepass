import { afterEach, describe, expect, it, vi } from 'vitest';
import { formsFor, matchesMapSelector } from '../src/content/autocomplete';
import {
  detectLoginFields,
  isNewPasswordField,
  isPasswordInput,
  isTotpField,
  readSubmitted,
} from '../src/content/detect';

function at(url: string, html: string) {
  vi.spyOn(document, 'location', 'get').mockReturnValue(new URL(url) as unknown as Location);
  document.body.innerHTML = html;
}
const byId = (id: string) => document.getElementById(id) as HTMLInputElement;

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('site maps (Map the Web format)', () => {
  const form = (name: string) => ({ category: 'account-login', fields: { username: [name] } });
  const map = {
    hosts: {
      'example.com': {
        forms: [form('site')],
        fragments: { '#login': { forms: [form('site-fragment')] } },
        pathnames: {
          '/': { fragments: { '#login': { forms: [form('root-fragment')] } } },
          '/account': { forms: [form('account')] },
          '/legal': null,
        },
      },
      'other.example': null,
    },
  };
  const names = (url: string) =>
    formsFor(map, new URL(url)).map((f) => f.fields.username?.[0] ?? '');

  it('resolves the most specific entry, as the map spec orders them', () => {
    expect(names('https://example.com/#login')).toEqual(['root-fragment']);
    expect(names('https://example.com/')).toEqual([]);
    expect(names('https://example.com/account/')).toEqual(['account']);
    expect(names('https://example.com/account#login')).toEqual(['account']);
    expect(names('https://example.com/help#login')).toEqual(['site-fragment']);
    expect(names('https://example.com/help')).toEqual(['site']);
    expect(names('https://example.com/legal#login')).toEqual([]);
    expect(names('https://other.example/login')).toEqual([]);
  });

  it('treats www as the bare host unless the map lists www itself', () => {
    expect(names('https://www.example.com/account')).toEqual(['account']);
    expect(names('https://example.com:8443/account')).toEqual([]);
  });

  it('crosses into shadow roots with >>>', () => {
    document.body.innerHTML = '<login-box id="box"></login-box>';
    const shadow = byId('box').attachShadow({ mode: 'open' });
    shadow.innerHTML = '<form><input id="user" name="user"></form>';
    const input = shadow.getElementById('user') as HTMLInputElement;
    expect(matchesMapSelector(input, 'login-box#box >>> form input#user')).toBe(true);
    expect(matchesMapSelector(input, 'other-box >>> form input#user')).toBe(false);
    expect(matchesMapSelector(input, 'form input#user')).toBe(true);
    expect(matchesMapSelector(input, 'input:unknown-pseudo')).toBe(false);
  });

  it('lets the map correct a page that marks its login password as new', () => {
    const html =
      "<div id='loginContainer'><form><input type='text' name='username' id='u' " +
      "autocomplete='webauthn'><input type='password' id='p' autocomplete='new-password'>" +
      '</form></div>';
    at('https://unmapped.example/login', html);
    expect(detectLoginFields().password).toBeNull();
    at('https://www.tiktok.com/login', html);
    expect(detectLoginFields()).toMatchObject({ username: byId('u'), password: byId('p') });
    expect(isNewPasswordField(byId('p'))).toBe(false);
  });
});

describe('Bitwarden field heuristics', () => {
  it('finds a password field that a show-password toggle turned into text', () => {
    at(
      'https://example.com/login',
      '<form><input id="u" name="email"><input type="text" id="pw" name="password"></form>',
    );
    expect(detectLoginFields()).toMatchObject({ username: byId('u'), password: byId('pw') });
    byId('u').value = 'me@example.com';
    byId('pw').value = 'hunter2';
    expect(readSubmitted(document)).toMatchObject({
      username: 'me@example.com',
      password: 'hunter2',
    });
  });

  it('never calls a password hint or a captcha box a password', () => {
    at(
      'https://example.com/',
      '<input id="h" name="password_hint"><input id="c" name="captcha" type="password">',
    );
    expect(isPasswordInput(byId('h'))).toBe(false);
    expect(isPasswordInput(byId('c'))).toBe(false);
  });

  it('treats a password box asking for a one-time code as the code, not the password', () => {
    at(
      'https://example.com/verify',
      '<form><input type="password" id="otp" name="otpCode"><button>Verify</button></form>',
    );
    expect(isPasswordInput(byId('otp'))).toBe(false);
    expect(detectLoginFields().password).toBeNull();
  });

  it('knows one-time code fields by Bitwarden’s names, and leaves recovery codes alone', () => {
    at(
      'https://example.com/2fa',
      '<input id="a" name="approvals_code"><input id="r" name="recovery_code" autocomplete="off">',
    );
    expect(isTotpField(byId('a'))).toBe(true);
    expect(isTotpField(byId('r'))).toBe(false);
  });

  it('sees "Confirm password" and "New password" fields as new, even alone', () => {
    at(
      'https://example.com/reset',
      '<form><label for="n">New password</label><input type="password" id="n"></form>',
    );
    expect(isNewPasswordField(byId('n'))).toBe(true);
    expect(detectLoginFields().password).toBeNull();
  });

  it('skips site search, newsletter, and new-email boxes when looking for a username', () => {
    at(
      'https://example.com/',
      '<form><input id="s" name="siteSearch" placeholder="Find anything"></form>' +
        '<form id="newsletter"><h3>Join our newsletter</h3><input type="email" id="news"></form>',
    );
    expect(detectLoginFields().username).toBeNull();
    at(
      'https://example.com/account',
      '<form><input type="email" id="new" name="new-email"><input type="password" id="p"></form>',
    );
    expect(detectLoginFields()).toMatchObject({ username: null, password: byId('p') });
  });

  it('takes the one text field of a form under a sign-in heading as the username step', () => {
    at(
      'https://example.com/signin',
      '<main><h1>Sign in</h1><form><input id="who" placeholder="Phone, email, or Skype">' +
        '<button>Next</button></form></main>',
    );
    expect(detectLoginFields().username).toBe(byId('who'));
    at(
      'https://example.com/contact',
      '<main><h1>Contact us</h1><form><input id="who" placeholder="Your phone">' +
        '<button>Send</button></form></main>',
    );
    expect(detectLoginFields().username).toBeNull();
  });

  it('knows German username labels', () => {
    at(
      'https://example.de/',
      '<form><label for="b">Benutzername</label><input id="b"><input type="password" id="p"></form>',
    );
    expect(detectLoginFields()).toMatchObject({ username: byId('b'), password: byId('p') });
  });
});
