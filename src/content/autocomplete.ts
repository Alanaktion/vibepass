/**
 * What a field's autocomplete value means, for detection: the role a curated site map gives it,
 * otherwise the page's own `autocomplete` attribute.
 *
 * Site maps use the format of Bitwarden's Map the Web forms map
 * (https://github.com/bitwarden/map-the-web, GPL-3.0), which lists CSS selectors for the login,
 * sign-up, and password-change fields of sites whose markup hides them. Its login-related part is
 * bundled as `src/data/forms-map.json` (refresh with `scripts/update-site-data.mjs`). Our own
 * patches for sites we hit live in `site-rules.json`, in the same format, and win over it, so
 * they can be sent upstream as they are.
 */

import upstream from '../data/forms-map.json';
import patches from './site-rules.json';

/** A forms map, as Map the Web publishes it (login-related subset). */
interface FormsMap {
  hosts: Record<string, HostEntry | null>;
}
interface FormEntry {
  category: string;
  fields: Partial<Record<string, (string | string[])[]>>;
}
interface PageEntry {
  forms?: FormEntry[];
  fragments?: Record<string, { forms?: FormEntry[] } | null>;
}
interface HostEntry extends PageEntry {
  pathnames?: Record<string, PageEntry | null>;
}

/** Map field keys to the autocomplete token detection already understands. */
const FIELD_TOKENS: Partial<Record<string, string>> = {
  username: 'username',
  email: 'username',
  password: 'current-password',
  newPassword: 'new-password',
  oneTimeCode: 'one-time-code',
};

/**
 * The forms that describe a URL, by the map's precedence: page fragment, page forms, site-wide
 * fragment, site-wide forms. A null entry means the page has no forms the map describes.
 */
export function formsFor(map: FormsMap, url: URL): FormEntry[] {
  const host = url.host.toLowerCase();
  const entry = map.hosts[host] ?? (host.startsWith('www.') ? map.hosts[host.slice(4)] : undefined);
  if (!entry) return [];
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') || '/' : '/';
  const hash = url.hash;
  const pathnames = entry.pathnames ?? {};
  if (Object.hasOwn(pathnames, path)) {
    const page = pathnames[path];
    if (!page) return [];
    if (hash && page.fragments && Object.hasOwn(page.fragments, hash)) {
      return page.fragments[hash]?.forms ?? [];
    }
    if (page.forms) return page.forms;
    if (hash && entry.fragments && Object.hasOwn(entry.fragments, hash)) {
      return entry.fragments[hash]?.forms ?? [];
    }
    return [];
  }
  if (hash && entry.fragments && Object.hasOwn(entry.fragments, hash)) {
    return entry.fragments[hash]?.forms ?? [];
  }
  return entry.forms ?? [];
}

/**
 * Does a map selector describe this input? `>>>` crosses into a shadow root or a same-origin
 * frame; each segment must match the element at that level, the last one the input itself.
 */
export function matchesMapSelector(input: Element, selector: string): boolean {
  const segments = selector.split('>>>').map((s) => s.trim());
  let el: Element | null = input;
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (!el || !segment) return false;
    try {
      if (!el.matches(segment)) return false;
    } catch {
      // A selector this browser can't parse describes nothing here.
      return false;
    }
    if (i === 0) break;
    const root = el.getRootNode();
    el =
      root instanceof ShadowRoot ? root.host : (el.ownerDocument.defaultView?.frameElement ?? null);
  }
  return true;
}

let cached: { href: string; rules: { selector: string; token: string }[] } | null = null;

/** The field selectors that apply to the top page's URL, our patches first. */
function rulesFor(href: string): { selector: string; token: string }[] {
  if (cached?.href === href) return cached.rules;
  const rules: { selector: string; token: string }[] = [];
  let url: URL | null;
  try {
    url = new URL(href);
  } catch {
    url = null;
  }
  if (url && (url.protocol === 'https:' || url.protocol === 'http:')) {
    for (const map of [patches as FormsMap, upstream as FormsMap]) {
      for (const form of formsFor(map, url)) {
        for (const [key, selectors] of Object.entries(form.fields)) {
          const token = FIELD_TOKENS[key];
          if (!token || !selectors) continue;
          // Sequences (one digit per box) aren't filled yet; plain selectors are.
          for (const selector of selectors) {
            if (typeof selector === 'string') rules.push({ selector, token });
          }
        }
      }
    }
  }
  cached = { href, rules };
  return rules;
}

/**
 * Fields the map named once keep that role, so the role survives the inline menu turning the
 * page's own autocomplete attribute off (which a map selector may test for).
 */
const mapped = new WeakMap<HTMLInputElement, string>();

/** The autocomplete token the site map gives this field, or null when the map doesn't name it. */
export function mapAutocomplete(input: HTMLInputElement): string | null {
  const known = mapped.get(input);
  if (known) return known;
  // Map entries describe the page the user sees: the top frame's URL, also for same-origin
  // frames inside it.
  let href = input.ownerDocument.location.href;
  const view = input.ownerDocument.defaultView;
  if (view?.top && view.top !== view) {
    try {
      href = view.top.location.href;
    } catch {
      // A cross-origin parent: this frame's own URL is all we have.
    }
  }
  for (const { selector, token } of rulesFor(href)) {
    if (matchesMapSelector(input, selector)) {
      mapped.set(input, token);
      return token;
    }
  }
  return null;
}

/**
 * The page's own autocomplete value, from before the inline menu turned the browser's form
 * history off on that field, so detection sees what the page meant.
 */
const originalAutocomplete = new WeakMap<HTMLInputElement, string | null>();

/** A field's autocomplete value as detection should read it, lowercased. */
export function fieldAutocomplete(input: HTMLInputElement): string {
  const fromMap = mapAutocomplete(input);
  if (fromMap) return fromMap;
  const original = originalAutocomplete.has(input)
    ? originalAutocomplete.get(input)
    : input.getAttribute('autocomplete');
  return (original ?? '').toLowerCase();
}

/** Hide the browser's own form-history dropdown on a field while the inline menu is open. */
export function suppressBrowserAutocomplete(input: HTMLInputElement): void {
  if (originalAutocomplete.has(input)) return;
  // Settle the map's verdict while the page's attributes are still intact.
  mapAutocomplete(input);
  originalAutocomplete.set(input, input.getAttribute('autocomplete'));
  input.setAttribute('autocomplete', 'off');
}

/** Put the page's autocomplete value back exactly as it was. */
export function restoreBrowserAutocomplete(input: HTMLInputElement): void {
  if (!originalAutocomplete.has(input)) return;
  const original = originalAutocomplete.get(input) ?? null;
  originalAutocomplete.delete(input);
  if (original === null) input.removeAttribute('autocomplete');
  else input.setAttribute('autocomplete', original);
}
