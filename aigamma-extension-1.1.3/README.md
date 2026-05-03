# AI Gamma SPX Regime Status and Metrics

Browser extension that surfaces derived SPX derivative metrics and a
high-impact macro alert ladder in a 360px popup, and reflects the current
dealer gamma regime on the toolbar icon at a glance.

Manifest V3. Vanilla HTML, CSS, and JavaScript. No bundler, no framework,
no third-party runtime dependencies.

## Layout

    aigamma-extension-1.1.3/
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

The Firefox build at `../aigamma-extension-firefox-1.1.3/` is byte-identical
to this folder except for the `browser_specific_settings.gecko` block in
the manifest (extension id `aigamma@aigamma.com`, `strict_min_version`
`115.0`, `data_collection_permissions: { required: ["none"] }`).

## Popup contents

Top to bottom in order:

1. Gamma status pill (POSITIVE / NEGATIVE / OFFLINE)
2. Alert ladder — three time-bucketed rows, hidden when empty:
   - red `< 24H` for HIGH-impact macro events firing in the next 24 hours
   - orange `24-48H` for events 24-48 hours out
   - yellow `48-72H` for events 48-72 hours out
3. SPX Reference + (delta vs prev close)
4. Overnight Align — score and three direction arrows
5. Gamma Index + (delta vs prev day) — value colored gamma-green if
   positive, red if negative
6. Dist from Risk Off — value colored gamma-green if SPX above Vol Flip,
   red if below; no delta (the value is already a differential)
7. Vol Flip + (delta vs prev day) — delta colored bullish-green up,
   yellow flat, red down
8. Term Slope — Contango (bullish-green) or Backwardation (red) text
9. VRP + (delta in pp) — value colored bullish-green positive, red negative
10. IV Rank + (delta in pp) — value colored gamma-green below 50, red at
    or above 50; delta uses inverted tone (rising IV rank = red)
11. Put Wall + (delta vs prev day) — delta colored bullish-green up,
    yellow flat, red down
12. Call Wall + (delta vs prev day) — same convention as Put Wall
13. ATM IV% + (delta in pp) — value AND delta both colored by inverted
    tone (lower than yesterday = gamma-green, flat = yellow, higher =
    red); the rename from "ATM IV" makes the percent unit explicit at the
    label
14. P/C (Volume) + (delta vs prev day)
15. P/C (OI) + (delta vs prev day)

The alert ladder is restricted to macroeconomic events with `impact ===
"High"` from the Forex Factory aggregator. Earnings tickers and Medium-
impact events that the landing-page CatalystBanner also surfaces are
excluded so the popup ladder reads as a strict macro-event filter rather
than the broader catalyst calendar.

The two greens diverge intentionally:
- **gamma green** `#02A29F` — regime/teal token used by the dashboard's
  LevelsPanel for Dist from Risk Off, Term Slope, Gamma Index, Overnight
  Alignment. Reused here for the same regime-tier cells.
- **bullish green** `#2ecc71` — equity/bullish token, the call-gamma
  corner-label color in the Gamma Map. Reused here for VRP positive,
  Contango, and the up-deltas on Vol Flip / Put Wall / Call Wall.

## Behavior

The popup fetches on open. Two parallel HTTPS requests:

- `https://aigamma.com/api/snapshot.json` — derived SPX metrics with a
  server-computed delta block against the most recent prior-trading-date
  ingest run.
- `https://aigamma.com/api/events-calendar` — Forex Factory aggregator,
  USD-only by server-side default; popup further filters to `impact ===
  "High"` and buckets into the three time windows.

Both endpoints serve open CORS (`Access-Control-Allow-Origin: *`) so the
manifest declares no `host_permissions`. The only declared permission is
`alarms`.

The background service worker schedules a `chrome.alarms` tick every two
minutes, gated to US equity market hours (Monday through Friday, 9:30 AM
to 4:00 PM Eastern, DST-aware via `Intl.DateTimeFormat` with `timeZone:
"America/New_York"`). Outside market hours the service worker no-ops
because the regime cannot change. On fetch failure the icon reverts to
neutral.

## Local testing

1. Open `chrome://extensions`.
2. Toggle Developer mode on (top right).
3. Click Load unpacked and select the `aigamma-extension-1.1.3` folder.
4. Pin the extension from the toolbar puzzle icon.
5. Click the icon. The popup opens and fetches from
   `aigamma.com/api/snapshot.json` and `aigamma.com/api/events-calendar`.

If the snapshot endpoint is unreachable, the popup displays OFFLINE in
red and the toolbar icon falls back to neutral. If the events endpoint is
unreachable, the alert ladder section collapses to nothing and the
metric rows render normally.

## Server side

The extension fetches from `https://aigamma.com/api/snapshot.json`, a
Netlify Function that lives in the same repository at
`netlify/functions/snapshot.mjs` and is routed via `netlify.toml`
redirects. The function reads from Supabase tables (`ingest_runs`,
`snapshots`, `computed_levels`, `expiration_metrics`,
`daily_volatility_stats`, `daily_gex_stats`, `vix_family_eod`) and
recomputes the Vol Flip zero crossing via `src/lib/gammaProfile.js`. The
response contract is `schemaVersion: 2` (additive on top of v1 — every
v1 field is preserved so older extension installs in the wild keep
working).

`schemaVersion: 2` adds:
- `prevClose`, `prevTradingDate`
- `gammaIndex`, `gammaIndexDate`
- `pcRatioOi`
- `termStructure: { vix, vix3m, ratio, asOf }`
- `deltas: { spot, volFlip, putWall, callWall, atmIv, ivRank, vrp,
  pcRatioVolume, pcRatioOi, gammaIndex }`

Verify locally from the repo root:

    netlify dev
    curl -i http://localhost:8888/api/snapshot.json

The response should be `200 OK` with `Access-Control-Allow-Origin: *`,
`Cache-Control: public, max-age=60, s-maxage=60, stale-while-revalidate=300`.

## Publishing

### Chrome Web Store

1. Pay the one-time $5 developer registration fee at
   https://chrome.google.com/webstore/devconsole.
2. Produce at least one screenshot (1280x800 or 640x400) of the popup.
3. Host the privacy policy at https://aigamma.com/extension-privacy.
   Source content lives in `PRIVACY.md`.
4. Zip the *contents* of this folder (not the folder itself). On Windows
   PowerShell, from inside `aigamma-extension-1.1.3/`:

        Compress-Archive -Path * -DestinationPath ..\aigamma-extension-1.1.3.zip

5. In the developer console, click New Version and upload the zip.
6. Submit. Review is typically one to three business days for low-permission
   MV3 extensions. The manifest declares only `alarms`; no host_permissions,
   no content scripts, no storage, no tabs.

### Firefox (addons.mozilla.org)

The Firefox build at `../aigamma-extension-firefox-1.1.3/` is the same code
with a `browser_specific_settings.gecko` block added to the manifest. Submit
its zip to addons.mozilla.org. AMO review typically takes three to ten
business days.

## Updating

Bump the `version` field in both `manifest.json` files using semver, rezip,
and upload as a new version in each store's developer console. The endpoint
schema is bumped on incompatible wire changes only — additive fields land
under the same `schemaVersion`.
