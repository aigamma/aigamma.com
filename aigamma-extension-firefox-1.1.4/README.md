# AI Gamma SPX Regime Status and Metrics

Browser extension that surfaces the federated AI landing-page narration,
derived SPX derivative metrics, and a high-impact macro alert ladder in a
440px popup, and reflects the current dealer gamma regime on the toolbar
icon at a glance.

Manifest V3. Vanilla HTML, CSS, and JavaScript. No bundler, no framework,
no third-party runtime dependencies.

## Layout

    aigamma-extension-1.1.4/
      manifest.json
      background.js        service worker: polls snapshot, swaps icon
      popup.html
      popup.css
      popup.js
      PRIVACY.md
      README.md
      icons/
        neutral/           AI GAMMA brand mark; pre-market, off-hours, fetch failure
          icon16.png
          icon32.png
          icon48.png
          icon128.png
        positive/          green plus; gammaStatus === "POSITIVE"
          icon16.png
          icon32.png
        negative/          red minus; gammaStatus === "NEGATIVE"
          icon16.png
          icon32.png

The Firefox build at `../aigamma-extension-firefox-1.1.4/` is byte-identical
to this folder except for the `browser_specific_settings.gecko` block in
the manifest (extension id `aigamma@aigamma.com`, `strict_min_version`
`115.0`, `data_collection_permissions: { required: ["none"] }`).

## Popup contents

Top to bottom in order:

1. Gamma status pill (POSITIVE / NEGATIVE / OFFLINE) in the header
2. AI narration card &ndash; a severity-banded block (CONTEXT / NOTABLE /
   SIGNIFICANT) with the federated landing-page narrative pulled from
   `/api/narrative?page=/`. Headline + multi-paragraph body, with the
   same `**__++--~~` inline markup the live `PageNarrator` React component
   uses. Hidden when no narrative is available.
3. Alert ladder &ndash; three time-bucketed rows, hidden when empty:
   - red `< 24H` for HIGH-impact macro events firing in the next 24 hours
   - orange `24-48H` for events 24-48 hours out
   - yellow `48-72H` for events 48-72 hours out
4. SPX Reference + (delta vs prev close)
5. Overnight Align &ndash; score and three direction arrows
6. Gamma Index + (delta vs prev day) &ndash; value colored gamma-green if
   positive, red if negative
7. Dist from Risk Off &ndash; value colored gamma-green if SPX above Vol
   Flip, red if below; no delta (the value is already a differential)
8. Vol Flip + (delta vs prev day) &ndash; delta colored bullish-green up,
   yellow flat, red down
9. Term Slope &ndash; Contango (bullish-green) or Backwardation (red) text
10. VRP + (delta in pp) &ndash; value colored bullish-green positive, red
    negative
11. IV Rank + (delta in pp) &ndash; value colored gamma-green below 50,
    red at or above 50; delta uses inverted tone (rising IV rank = red)
12. Put Wall + (delta vs prev day) &ndash; delta colored bullish-green up,
    yellow flat, red down
13. Call Wall + (delta vs prev day) &ndash; same convention as Put Wall
14. ATM IV% + (delta in pp) &ndash; value AND delta both colored by
    inverted tone (lower than yesterday = gamma-green, flat = yellow,
    higher = red)
15. P/C (Volume) + (delta vs prev day)
16. P/C (OI) + (delta vs prev day)

The alert ladder is restricted to macroeconomic events with `impact ===
"High"` from the Forex Factory aggregator. Earnings tickers and Medium-
impact events that the landing-page CatalystBanner also surfaces are
excluded so the popup ladder reads as a strict macro-event filter rather
than the broader catalyst calendar.

The two greens diverge intentionally:
- **gamma green** `#02A29F` &ndash; regime/teal token used by the
  dashboard's LevelsPanel for Dist from Risk Off, Term Slope, Gamma
  Index, Overnight Alignment. Reused here for the same regime-tier cells.
- **bullish green** `#2ecc71` &ndash; equity/bullish token, the
  call-gamma corner-label color in the Gamma Map. Reused here for VRP
  positive, Contango, and the up-deltas on Vol Flip / Put Wall / Call
  Wall.

The narration card uses a third palette that mirrors the canonical
four-token aigamma.com palette consumed by the live React narrator:
**accent-blue** `#4a9eff` for tickers and defined terms (`__text__`),
**accent-coral** `#d85a30` for negative moves and alert levels
(`--text--`), **accent-amber** `#f0a030` for threshold trips and watch
alerts (`~~text~~`), and **bullish-green** for positive moves
(`++text++`). `**bold**` and `*italic*` markup render in the body's
default text color.

## Behavior

The popup fetches on open. Three parallel HTTPS requests:

- `https://aigamma.com/api/snapshot.json` &ndash; derived SPX metrics
  with a server-computed delta block against the most recent
  prior-trading-date ingest run.
- `https://aigamma.com/api/events-calendar` &ndash; Forex Factory
  aggregator, USD-only by server-side default; popup further filters to
  `impact === "High"` and buckets into the three time windows.
- `https://aigamma.com/api/narrative?page=/` &ndash; latest federated
  landing-page narrative from `public.page_narratives`, refreshed every
  5 market-hour minutes by `narrate-background.mjs`. Returns
  `{ narrative: { headline, body, severity, created_at, ... } }` or
  `{ narrative: null }` when no row exists yet for `/`.

All three endpoints serve open CORS (`Access-Control-Allow-Origin: *`)
so the manifest declares no `host_permissions`. The only declared
permission is `alarms`.

The background service worker schedules a `chrome.alarms` tick every two
minutes year-round (the previous market-hours gate was removed in v1.1.3
so the toolbar icon refreshes promptly on weekend wakes and post-cold-
start sideloads). The narrative endpoint is **not** polled in the
background &ndash; it is fetched only when the popup opens, since the
narrative does not affect the toolbar icon. On snapshot fetch failure
the icon reverts to neutral; on narrative fetch failure the popup simply
hides the narration card.

## Local testing

1. Open `about:debugging#/runtime/this-firefox`.
2. Click Load Temporary Add-on and select any file inside the
   `aigamma-extension-firefox-1.1.4` folder (Firefox loads the entire
   directory).
3. Pin the extension from the toolbar overflow menu.
4. Click the icon. The popup opens and fetches from
   `aigamma.com/api/snapshot.json`, `aigamma.com/api/events-calendar`,
   and `aigamma.com/api/narrative?page=/`.

If the snapshot endpoint is unreachable, the popup displays OFFLINE in
red and the toolbar icon falls back to neutral. If the events endpoint
is unreachable, the alert ladder section collapses to nothing and the
metric rows render normally. If the narrative endpoint is unreachable
or returns no row for `/`, the narration card stays hidden and the
popup degrades gracefully to the v1.1.x layout.

## Server side

The extension fetches three Netlify Functions in the same repository,
all routed via `netlify.toml` redirects:

- `netlify/functions/snapshot.mjs` &ndash; reads from Supabase tables
  (`ingest_runs`, `snapshots`, `computed_levels`, `expiration_metrics`,
  `daily_volatility_stats`, `daily_gex_stats`, `vix_family_eod`) and
  recomputes the Vol Flip zero crossing via `src/lib/gammaProfile.js`.
  The response contract is `schemaVersion: 2` (additive on top of v1
  &ndash; every v1 field is preserved so older extension installs in
  the wild keep working).
- `netlify/functions/events-calendar.mjs` &ndash; Forex Factory
  aggregator with USD-only server-side default.
- `netlify/functions/narrative.mjs` &ndash; reads
  `public.page_narratives` for a single page key. Added
  `Access-Control-Allow-Origin: *` in v1.1.4 so the popup's third
  parallel fetch resolves under the same CORS posture as the other two.

`schemaVersion: 2` (snapshot.json) adds:
- `prevClose`, `prevTradingDate`
- `gammaIndex`, `gammaIndexDate`
- `pcRatioOi`
- `termStructure: { vix, vix3m, ratio, asOf }`
- `deltas: { spot, volFlip, putWall, callWall, atmIv, ivRank, vrp,
  pcRatioVolume, pcRatioOi, gammaIndex }`

Verify locally from the repo root:

    netlify dev
    curl -i http://localhost:8888/api/snapshot.json
    curl -i http://localhost:8888/api/events-calendar
    curl -i 'http://localhost:8888/api/narrative?page=/'

Each response should be `200 OK` with `Access-Control-Allow-Origin: *`.

## Publishing

### Firefox (addons.mozilla.org)

1. Sign in at https://addons.mozilla.org/en-US/developers/.
2. Produce at least one screenshot of the popup.
3. Host the privacy policy at https://aigamma.com/extension-privacy.
   Source content lives in `PRIVACY.md` and the public HTML render lives
   at `public/extension-privacy.html`.
4. Zip the *contents* of this folder (not the folder itself). On Windows
   PowerShell, from inside `aigamma-extension-firefox-1.1.4/`:

        Compress-Archive -Path * -DestinationPath ..\aigamma-extension-firefox-1.1.4.zip

   The repo root also contains a pre-built
   `aigamma-extension-firefox-1.1.4.zip` ready for upload.
5. In the AMO developer console, upload the zip as a new version. AMO
   review typically takes three to ten business days for low-permission
   MV3 extensions.

### Chrome Web Store

The Chrome build at `../aigamma-extension-1.1.4/` is the same code
without the `browser_specific_settings.gecko` block. Submit
`../aigamma-extension-1.1.4.zip` (also pre-built at the repo root) to
the Chrome Web Store. Chrome review typically takes one to three
business days for low-permission MV3 extensions.

## Updating

Bump the `version` field in both `manifest.json` files using semver, rezip,
and upload as a new version in each store's developer console. The endpoint
schema is bumped on incompatible wire changes only &ndash; additive fields
land under the same `schemaVersion`. The narrative endpoint is not
versioned; its shape is `{ narrative: { headline, body, severity,
created_at, model_used, prompt_version } | null }`.
