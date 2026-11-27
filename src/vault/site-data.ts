/**
 * Apple's password-manager-resources (https://github.com/apple/password-manager-resources, MIT),
 * bundled in `src/data/` and refreshed with `scripts/dev/update-site-data.mjs`:
 *
 * - password rules for sites that don't declare `passwordrules` on their fields, in the same
 *   syntax, so the generator makes a password the site will accept;
 * - groups of sites that share one account (envato.com and themeforest.net, an old domain and
 *   its new one).
 *
 * Apple asks that shared accounts only be suggested, with the saved site shown, never filled
 * without the user's say. So they rank in quick find (which shows each item's site and asks
 * before a fill on a site the item isn't saved for) and never count as a match for autofill.
 */
import rulesData from '../data/apple-password-rules.json';
import sharedData from '../data/apple-shared-credentials.json';
import { parseUri } from './match';

const RULES: Readonly<Record<string, string | undefined>> = rulesData.rules;

/** Apple's password rules for a page, from its hostname or the nearest parent listed. */
export function passwordRulesFor(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (let name = host; name.includes('.'); name = name.slice(name.indexOf('.') + 1)) {
    const rules = RULES[name];
    if (rules) return rules;
  }
  return null;
}

interface SharedGroup {
  shared?: string[];
  from?: string[];
  to?: string[];
}

let related: Map<string, Set<string>> | null = null;

function domainOf(name: string): string | null {
  return parseUri(`https://${name}`)?.domain ?? null;
}

function buildRelated(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const link = (page: string, saved: string) => {
    const a = domainOf(page);
    const b = domainOf(saved);
    if (!a || !b || a === b) return;
    let set = map.get(a);
    if (!set) map.set(a, (set = new Set()));
    set.add(b);
  };
  for (const group of sharedData.groups as SharedGroup[]) {
    const shared = group.shared ?? [];
    for (const page of shared) for (const saved of shared) link(page, saved);
    // One way only: an account saved on the old domain works on the new one.
    for (const page of group.to ?? []) for (const saved of group.from ?? []) link(page, saved);
  }
  return map;
}

const NONE: ReadonlySet<string> = new Set();

/** Registrable domains whose saved logins Apple says also sign in on this one. */
export function sharedCredentialDomains(domain: string): ReadonlySet<string> {
  related ??= buildRelated();
  return related.get(domain) ?? NONE;
}
