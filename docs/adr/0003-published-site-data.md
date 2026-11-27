# ADR 0003: Published site data for autofill

- Status: accepted
- Date: 2026-11-27
- Deciders: Alan (asked to reuse published lists instead of reverse-engineering each site)

## Context

Login detection fails on sites whose markup hides what a field is for: a password field marked
`new-password`, an email box with no name, a one-time code field labelled only "Code". Fixing
each site by hand doesn't scale for a small extension. Three published sources cover much of
this, and reusing proven Bitwarden code is already the project's standing decision.

## Decision

1. **Bitwarden's field heuristics.** `src/content/fields.ts` adapts the keyword lists and
   qualification rules from Bitwarden's browser extension (GPL-3.0, like Vibepass): username,
   email, one-time code, recovery code, search, captcha, sign-up and new-password words; text
   fields that are really passwords (show-password toggles); the newsletter and heading
   tie-breaks for a lone email box. `detect.ts` keeps its own structure (DOM order, forms,
   scoring) and asks these checks along the way, so the corpus and Microsoft fixes still hold.
   We don't adopt Bitwarden's page-collection services or inline-menu code, which would dictate
   the UI.
2. **Bitwarden's Map the Web forms map** (GPL-3.0, https://github.com/bitwarden/map-the-web):
   human-curated selectors for login, sign-up, password-change, and recovery fields per host,
   path, and fragment. `scripts/dev/update-site-data.mjs` downloads the latest release and keeps
   only login-related categories and fields, as `src/data/forms-map.json`, bundled in the content
   script (about 26 KB). A field the map names gets the matching autocomplete role
   (`username`, `current-password`, `new-password`, `one-time-code`), which wins over the page's
   own attribute. Our own patches go in `src/content/site-rules.json` in the same format and win
   over the map, so they can be offered upstream unchanged. Selector sequences (one digit per
   box) are not used yet.
3. **Apple's password-manager-resources** (MIT):
   - Password rules for sites without a `passwordrules` attribute feed the generator, which
     already parses that syntax through the SDK.
   - Shared-credential groups only **suggest**: quick find lists logins saved for a related site
     under their own heading, with each item's site shown. Following Apple's guidance, they are
     never autofill matches, so filling one goes through the usual "isn't saved for this site"
     confirmation and the inline menu doesn't offer them.
   - Change-password URLs are not used yet.

The data is vendored, not fetched at runtime: no new host permission, no network request per
page, and updates are reviewed as diffs.

## Consequences

- Refreshing data is a manual step: run the script, read the diff, run `npm run check`.
- Map the Web is experimental upstream; the script checks the schema major version and fails
  on anything but 1.x.
- When a site breaks, check the map first, then the general heuristics, and only then add a
  patch, with a corpus page.
