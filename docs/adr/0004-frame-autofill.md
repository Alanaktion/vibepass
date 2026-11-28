# ADR 0004: Autofill inside frames

- Status: accepted
- Date: 2026-11-28
- Deciders: Alan (chose the card rule for cross-site frames)

## Context

Most checkouts don't host their own card fields: Stripe, Braintree, Adyen, Square, and Shopify
put them in a frame on the provider's own domain, sometimes one frame per field. Some sites
embed a login form from another site the same way. Until now the content script ran only in the
top frame and read into same-origin frames. That never worked in Chrome, because elements read
from another frame belong to that frame's script world, where `instanceof` checks fail. So
card fill missed most real checkouts.

A frame is also how a page can try to collect what Vibepass fills. A page can put a hidden or
see-through frame over its form, or embed a frame from any site it likes. The card number goes
to whatever origin hosts the frame.

## Decision

1. **The content script runs in every frame** (`all_frames: true`, no new permission). The top
   frame keeps the inline menu and save banner. Every other frame runs `src/content/frame.ts`,
   which tells the worker once it has form fields, reports what fields it has, and fills only
   when the worker asks. The top page no longer reads into frames.
2. **The worker decides per frame.** It inspects the top page and every registered frame when a
   fill starts. Frame ids come from the browser (`sender.frameId`), and each fill message names
   the origin the worker checked, which the frame compares with its own before filling.
3. **Logins** go to the frame the user was typing in, else the top page if it has a login
   form, else a visible frame that has one. The checks are the same as for the top page, against
   the _frame's_ origin: saved for that site, no https-to-http downgrade, otherwise ask first.
   This matches Bitwarden. A login frame on a page from another site isn't asked about,
   because the password only goes to its own site.
4. **Cards and identities** fill the top page's share of the form plus every frame that holds
   fields of it, if all of these hold:
   - The top page passes the usual card rule: https, or the user confirmed.
   - The frame is https, or localhost.
   - The frame is visible. It must be at least 10×10 px, and where Chrome can tell
     (IntersectionObserver v2), the fields aren't transparent, covered, or off screen. The
     frame checks this again just before it fills.
   - The frame is from the page's own registrable domain or a known payment provider
     (`src/background/payment-frames.ts`). A frame from any other site makes the popup ask
     once, naming the frame's host. The inline menu tells the user to use the popup instead.
5. **Each frame gets only its own values.** A frame that reports only the security code gets
   only the code. Identity frames never get the SSN, passport, or licence number.
6. **Split forms.** A frame holding just part of a card (the code alone, say) counts only when
   the field's autocomplete token names it, and only when some frame or the top page has the
   number or expiry. A field the top page tags `cc-name` next to such frames counts too, and it
   gets the inline menu.

## Consequences

- Card fill works on most hosted payment fields, including one-field-per-frame layouts.
- The inline menu doesn't open inside frames yet. A card field's frame is often about 40 px
  tall, so a menu drawn inside it would be clipped. Drawing it from the top page over the frame
  is possible later, but the frame's position has to come from the frame chain without
  trusting the page.
- Logins submitted inside a frame don't get the save banner yet.
- Firefox has no IntersectionObserver v2, so there only the frame's size is checked.
- The provider list needs upkeep. A checkout with an unknown provider asks once per fill until
  that provider is added.
- `scripts/dev/frame-fill-check.mjs` checks all of this in Chromium over local https.
