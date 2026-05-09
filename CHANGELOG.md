# Changelog

## 1.1.6 — 2026-05-09 — Browser extension metric reorder + Volatility Flip rename

The browser extension popup metric ladder was regrouped so the
strike-level cells (Volatility Flip, Call Wall, Put Wall) now sit
contiguous as a block immediately below Dist from Risk Off, and the
implied-vol cells (Term Structure, VRP, IV Rank, ATM IV%) drop below
the wall pair. The full v1.1.6 row order from top to bottom is: SPX
(15min delayed), Overnight Align, Gamma Index, Dist from Risk Off,
Volatility Flip, Call Wall, Put Wall, Term Structure, VRP, IV Rank,
ATM IV%, P/C (Volume), P/C (OI). Eric specified the regrouping
explicitly: keeping the three SPX strike-level metrics adjacent makes
the ladder read as two semantic groups (price-level cells, then
volatility-surface cells) rather than the prior interleaving where the
walls sat below the IV metrics.

The "Vol Flip" label was renamed to "Volatility Flip" in the popup,
matching the more-readable noun-phrase form. The change is purely a
display-string rename: the JS variable name `volFlip`, the snapshot.json
wire field name `volFlip`, the element ID `volFlip`, and the JS
variable references in `popup.js`'s applyDeltas function are all
unchanged so the rename does not affect the
schemaVersion-2-compatibility guarantee or the IDs that
`getElementById` relies on. The user-visible places that absorbed the
rename are the popup row label itself and the two tooltips that
reference the metric by name (the Overnight Align row's title attribute
which describes the directional score's components, and the Dist from
Risk Off row's title which describes the differential's reference
level). Internal popup.js comments that mention "Vol Flip" alongside
the JS variable name were left as the abbreviated form for symmetry
with the variable, with a header-comment note explaining the asymmetry.

The change is purely an ordering and label change in `popup.html` (the
`<div class="row">` blocks for Term Structure, VRP, and IV Rank were
moved as a group from immediately after Volatility Flip down to
immediately after Put Wall, and the Volatility Flip row's label text
plus two tooltip mentions of "Vol Flip" were rewritten). No CSS, no
JavaScript logic, and no manifest behavioral changes ship with this
version. Both extension manifests now declare `"version": "1.1.6"`,
both popup.js header comments name the v1.1.6 regrouping + rename,
both READMEs reflect the new row ordering and the rename in the "Popup
contents" section, `package.json` and `package-lock.json` mirror the
bump, and both submission-ready zips at the repo root were rebuilt
against the new directory names (`aigamma-extension-1.1.6/` and
`aigamma-extension-firefox-1.1.6/`).

## 1.1.5 — 2026-05-09 — Browser extension Call Wall promoted above Put Wall

The Call Wall row in the popup metric ladder was promoted above the Put
Wall row, so the row order across the two strike-concentration cells
now reads Call Wall (item 12) then Put Wall (item 13) rather than the
prior Put Wall (item 12) then Call Wall (item 13). The change was
prompted by Eric stating the Call Wall is the more important of the two
levels and should not be the row that falls below the popup's
~600px-cap scroll fold when the AI narration card is rendered above
the metric ladder. The popup's scrollable max-height is unchanged from
v1.1.4 (still 600px with overflow-y: auto and a dark webkit
scrollbar), but the cut now lands one row earlier so the priority Call
Wall stays visible without scrolling and the lower-priority Put Wall
slips below the fold instead.

The swap is purely an ordering change in `popup.html` (the two
`<div class="row">` blocks for `id="callWall"` and `id="putWall"` were
exchanged in their textual position; ID selectors and JavaScript render
hooks are unchanged because `popup.js` looks rows up by element ID, not
by document order). No CSS, no JavaScript, and no manifest behavioral
changes ship with this version. Both extension manifests now declare
`"version": "1.1.5"`, both READMEs reflect the new row ordering in the
"Popup contents" section (Call Wall description moves to item 12 with a
note about the v1.1.5 promotion, Put Wall description drops to item 13
with "same convention as Call Wall" replacing "same convention as Put
Wall"), `package.json` and `package-lock.json` mirror the bump, and
both submission-ready zips at the repo root were rebuilt against the
new directory names (`aigamma-extension-1.1.5/` and
`aigamma-extension-firefox-1.1.5/`).

## 1.1.4 — 2026-05-09 — Browser extension AI narration card + popup overflow scrolling

The browser extension popup now leads with a federated AI narration card
that mirrors the same severity-banded narrative the live site shows at
the top of `/`. The card is fed by a third parallel fetch on popup open
to `https://aigamma.com/api/narrative?page=/`, which reads the most
recent row of `public.page_narratives` written by `narrate-background.mjs`
every five market-hour minutes. Headline + multi-paragraph body, with
the same `**__++--~~` inline markup vocabulary the React `PageNarrator`
component uses, ported to vanilla DOM API in `popup.js` to honor the
extension's existing "no innerHTML" security stance.

The popup body widened from 360px to 440px to give the narration body
room to breathe at the 13px Calibri body size (~60 chars per line). At
360px the narrator's three-paragraph landing-page bodies rendered as a
vertical noodle of broken sentences. Chrome's MV3 popup max width is
800px so 440 is well within safe bounds across desktop screen sizes.

Severity is signaled by the left-border accent color (text-secondary on
CONTEXT, accent-amber on NOTABLE, accent-coral on SIGNIFICANT) plus a
faint horizontal background gradient on tier 2 / 3, matching
`PageNarrator.jsx`'s visual treatment exactly. The chip in the meta row
carries a colored pill of the same tier color so the severity tag is
readable at a glance without parsing the stripe alone. Hidden when no
narrative is available; the popup degrades gracefully to the v1.1.x
layout (alerts ladder + 13 metric rows) when the narrative endpoint
returns null or fails.

The popup also gained internal scrolling. Chrome and Firefox both cap
browser-action popups at ~600px tall, and without an explicit overflow
rule the browser TRUNCATES content past the cap rather than surfacing a
scrollbar. The narration card pushed the popup well past 600px on a
typical three-paragraph narrative, hiding the four bottom metric rows
(Call Wall, ATM IV%, P/C Volume, P/C OI) and the asOf timestamp
completely below the fold and out of reach. Setting `max-height: 600px`
plus `overflow-y: auto` on `body` lets the popup scroll internally; a
companion dark `::-webkit-scrollbar` block makes the scrollbar visible
against the popup's `#0b0f1a` background, plus `scrollbar-width: thin`
+ `scrollbar-color: var(--border) var(--bg)` for Firefox.

Server-side fix: `netlify/functions/narrative.mjs` now sets
`Access-Control-Allow-Origin: *` on both its `jsonOk` and `jsonError`
response paths, so the popup's chrome-extension:// origin (running with
no `host_permissions` declared) can consume the endpoint as a third
parallel fetch alongside `snapshot.json` and `events-calendar`, both of
which already set the same wildcard header.

Documentation refreshed across all three privacy surfaces:
`aigamma-extension-1.1.4/PRIVACY.md`,
`aigamma-extension-firefox-1.1.4/PRIVACY.md`, and the publicly-served
`public/extension-privacy.html` at https://aigamma.com/extension-privacy.
The "Last updated" date moved from 2026-05-03 to 2026-05-09. The "What
the extension does" section now enumerates three endpoints. The "What
aigamma.com receives" and "Permissions justification" sections update
accordingly.

Both extension directories were renamed (`aigamma-extension-1.1.3/` to
`aigamma-extension-1.1.4/`, `aigamma-extension-firefox-1.1.3/` to
`aigamma-extension-firefox-1.1.4/`) and submission-ready zip files
(`aigamma-extension-1.1.4.zip` for the Chrome Web Store,
`aigamma-extension-firefox-1.1.4.zip` for AMO) were rebuilt at the repo
root. The version was set as a patch bump on v1.1.3 rather than a minor
v1.2.0 because the new narration card is a content-presentation
addition rather than a new wire-protocol surface; the snapshot endpoint
schema is unchanged at `schemaVersion: 2`.

## 1.1.2 — 2026-04-19 — Overnight Alignment metric + mobile-friendly labs

This is the first semver-tagged release of aigamma.com. The existing
history up to this point is the dated entries below; going forward the
`package.json` `version` field will be the source of truth for what is
deployed, and entries under a version heading describe the changes that
shipped in that version.

Two user-visible changes ship together in 1.1.2:

**Overnight Alignment replaces IV Percentile in the dashboard header
row.** The new stat sits where IV Percentile used to sit in
`src/components/LevelsPanel.jsx` (the middle row of the levels card, third
column). It compares today's Put Wall, Vol Flip, and Call Wall against
the prior trading day's final values and reports the net agreement as a
signed score in `[-3, +3]`: +3 means all three levels rose, -3 means all
three fell, 0 means a wash, and the partial values in between
(±1, ±2) mean a subset agreed. A per-level breakdown renders
underneath — "PW ↑  VF ↑  CW ↑" for a fully-aligned-up day and whatever
combination of up, down, and em-dash glyphs fits the day otherwise.
Colors step through coral / amber / green at `|score| ≥ 2` so the site
paints a strong alignment without declaring it a signal; the framing is
informational. The IV Percentile stat was removed entirely (no
backward-compat shim), and the upstream `ivPercentile` /
`ivLookbackDays` fields on the `vrpMetric` derivation in `src/App.jsx`
were dropped with it because `LevelsPanel` was the only consumer. IV
Rank, VRP, and the two P/C ratio cells in the same row are unchanged.
The alignment score uses the client-side-corrected `volatility_flip` on
both days (the zero-crossing of the gamma profile) so the overnight
comparison isn't a mix of fresh profile today vs stale backend
gamma-max flip yesterday.

**Alpha (/alpha) and Beta (/beta) labs are now mobile-friendly at the
same breakpoints as the production dashboard.** The two lab shells
already inherited the viewport meta and some mobile scaling from the
original implementation, but the treatment stopped at the badge and
logo; the warning strip, the slot cards, the footer, and the placeholder
chrome all kept their desktop padding on phone widths. `src/styles/lab.css`
now adds a second pass at `@media (max-width: 768px)` that tightens
every lab-specific chrome element (warning padding, slot gap, card
padding scoped to `.lab-shell .card` so the main dashboard's cards are
untouched, placeholder font sizes, footer spacing) and a new
`@media (max-width: 480px)` block that scales one more step down for
phone-width viewports (badge height 2.8 → 2.4rem, meta 0.72 → 0.68rem,
footer letter-spacing eases for legibility at the smallest label size).
The structure of the layout is unchanged — nothing reflows, nothing
hides on mobile — so a component developed in a lab slot on desktop
renders in the same hierarchy on mobile. The two lab footers now
include a `v1.1.2` version token at the end of their existing text; the
alpha footer reads "AI Gamma · α lab · software-stage sense ·
v1.1.2" and the beta footer reads "AI Gamma · internal beta lab ·
not for public consumption · v1.1.2". The main dashboard at `/` does not
carry a visible version marker because the production surface has never
had a footer; readers who want to confirm the deployed version can read
it from `package.json` in the repo.

Verified clean: `npm run lint` returns 0 / 0, `npm run build` emits the
three entries with no vendor chunk regressions, `vite preview` serves
200 at `/`, `/alpha`, and `/beta`. The alpha slot content at
`alpha/slot.jsx` (the put-call parity box-spread model prompted by
sflush in the Discord chat) was deliberately not touched in this pass
— that component already imports `useIsMobile` and handles its own
responsive behavior internally, and it is also under a hands-off hold
until ~2026-04-23 because it is a visible example for a community
member.

## 2026-04-17 — Post-launch audit of Chrome extension + site

This is a findings-and-fixes log from a broad audit of the project after the
Chrome extension server side shipped (see commit `0e9ed6a`). The audit covered
the extension client (`aigamma-extension/`), the new Netlify Function
(`netlify/functions/snapshot.mjs`), the privacy page, the shared-module
extraction in `src/lib/dates.js`, the dashboard React tree, and the existing
ingest/data functions. Nothing visible on the dashboard changes behavior;
everything here is either a bug fix, a dead-code removal, a consolidation, or
a note worth tracking.

### Fixes shipped in this commit

**Extension client (`aigamma-extension/`)**

- `popup.js` — Expected Move was rendering with a misleading `+` sign prefix
  because it was passed through the `signed()` helper. Expected Move is a
  symmetric magnitude (always ≥ 0), not a directional signed value — rendering
  it as `+281.00` reads like a positive return rather than a bidirectional
  band. Added a new `magnitude()` formatter that prefixes with `±` instead,
  and pointed `expMove` at it. `distRiskOff` still uses `signed()` because the
  sign is meaningful there (positive = spot above Vol Flip, negative = spot
  below).
- `popup.js` — On fetch failure, only the status pill and the `asOf` row were
  being updated. Every other value row kept showing its initial "..." loading
  placeholder forever, which reads like "still loading" rather than "offline."
  The catch block now resets every value span to `-` so the OFFLINE state is
  unambiguous.
- `popup.js` — Dropped the unused `e` binding in the catch clause (ESLint
  `no-unused-vars`). Changed `catch (e)` to `catch`.
- `manifest.json` — Added `"homepage_url": "https://aigamma.com/"` so the
  Chrome Web Store listing has a canonical link back to the dashboard. No
  effect on runtime behavior.

**Dashboard (`src/`)**

- `hooks/useHistoricalData.js` — Removed two dead stub exports
  (`useHistoricalTermStructure` and `useHistoricalCloudBands`) that always
  returned `{ data: null, loading: false, error: null }` and had zero callers
  anywhere in the codebase. They were placeholders for features that never
  landed.
- `components/LevelsPanel.jsx` — Consolidated duplicate `isThirdFridayMonthly`
  definition. The helper was duplicated here and in `src/lib/dates.js` (the
  shared-module extraction from the previous commit). Removed the local copy
  and imported the shared one. Behavior is byte-identical — the two
  implementations agreed on every input — but having one source of truth
  means future edits to the SPX 3rd-Friday rule (e.g., a schedule change that
  shifts the AM-settled standard) only need a single edit.

**Netlify Functions**

- `ingest.mjs` / `ingest-background.mjs` — The hardcoded `US_MARKET_HOLIDAYS`
  sets expire at end of 2028. The comment above them said "Hardcoded through
  2028" but didn't flag what happens after. Extended the comment to call out
  the refresh deadline (before 2028-12-31) and describe the silent-failure
  mode on both sides: `ingest.mjs` would let the ingest fire on closed-market
  days (wasted Massive API calls, empty runs), and `ingest-background.mjs`'s
  `prevTradingDay` rollback would emit a closed-market day as the previous
  trading date.

### Observations left unchanged (context for future work)

These are things the audit found but chose not to touch, with reasons.

1. **`src/components/GammaThrottleScatter.jsx:416` — pre-existing lint
   violation.** The `react-hooks/set-state-in-effect` rule flags
   `setScatterError(null)` inside the Plotly render effect. It's a real
   pattern that React 19's strict mode discourages because it can cascade
   renders, but the fix requires either a `queueMicrotask` deferral, a ref-
   based error-state pattern, or restructuring the render to happen in an
   event handler. I didn't introduce the issue and a quick fix felt risky
   (the chart renders fine today), so I left it. It's the only lint error in
   the repo — worth fixing in a dedicated pass with visual verification that
   the chart still renders the same way on failure.

2. **Extension CSS palette differs from the site palette.** The site uses
   `#0d0f13` / `#141820` / `#4a9eff` / `#2ecc71`; the extension popup uses
   `#0b0f1a` / `#1f2937` / `#10b981` / `#ef4444` (closer to Tailwind slate +
   emerald). Not a bug — a stylistic divergence. The extension renders in a
   320px popup against Chrome's own chrome, where the cooler-slate palette
   looks a bit tighter than the site's palette would. CLAUDE.md says the two
   **dashboard surfaces** (aigamma.com + about.aigamma.com) should be
   consistent, which they are — the extension is a third surface with
   different presentation constraints. If you want to align, the fix is a
   two-line tweak in `aigamma-extension/popup.css` (swap the `--bg`, `--pos`,
   `--neg` values); I can do that on request.

3. **`netlify/functions/snapshot.mjs` 503 responses leak internal error
   messages.** On query failure, the body includes strings like
   `"computed_levels query failed: 500"` — i.e., internal table names. Not
   security-sensitive (no PII, no secrets), and the popup never renders the
   body (treats any non-200 as OFFLINE), so it's useful for debugging via
   curl. Acceptable tradeoff.

4. **`src/components/RangeBrush.jsx` doesn't explicitly call
   `releasePointerCapture`.** It calls `setPointerCapture` on pointerdown
   but relies on the browser's automatic release on pointerup at the
   captured target. That auto-release does fire correctly for all tested
   drag paths, so the code is not broken. Adding an explicit release would
   be slightly more defensive but is not a bug.

5. **`SUPBASE_SERVICE_KEY` typo in Netlify env (follow-up, not a code
   issue).** The service-role key is stored in Netlify production env as
   `SUPBASE_SERVICE_KEY` — missing the A in `SUPABASE`. This is almost
   certainly why the ingest pipeline's RLS-bypass INSERT for the gamma
   profile is being blocked, which is why the dashboard and now
   `snapshot.mjs` both recompute the Vol Flip client-side instead of
   reading `computed_levels.volatility_flip`. Renaming the env var to
   `SUPABASE_SERVICE_KEY` and redeploying the ingest function should
   restore persisted profile writes. This is ops work (Netlify dashboard),
   not a code change. The previous commit's rationale already documents
   this as a follow-up; it's repeated here for visibility.

### Verification

- `npm run build` passes (dist bundle size `265.76 kB` gzip `82.73 kB`,
  down from `265.88 kB` before the dead-hook removal and
  `isThirdFridayMonthly` consolidation — a ~0.12 kB ungzipped reduction).
- `npm run lint` shows **1 pre-existing error** (the
  `GammaThrottleScatter.jsx:416` case documented above), **0 warnings**.
  The popup.js lint error that was present before this audit is now cleared.
- Production endpoint `https://aigamma.com/api/snapshot.json` still returns
  200 with all three required headers (CORS, Cache-Control, Content-Type)
  and the full schema.
- Production privacy page `https://aigamma.com/extension-privacy` still
  returns 200 with content-length 6048 matching the published file.
