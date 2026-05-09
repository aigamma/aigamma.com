# AI Gamma SPX Regime Status and Metrics &ndash; Privacy Policy

Last updated: 2026-05-09
Canonical URL: https://aigamma.com/extension-privacy

The AI Gamma SPX Regime Status and Metrics browser extension ("the
extension") is published by Eric Allione (AI Gamma, Prescott, AZ) and
operates as described below.

## What the extension does

When the user clicks the extension icon, the popup issues three HTTPS
requests in parallel:

1. `https://aigamma.com/api/snapshot.json` &ndash; derived SPX market
   statistics (gamma regime, key positioning levels, volatility metrics,
   prior-day deltas).
2. `https://aigamma.com/api/events-calendar` &ndash; public macroeconomic
   event calendar, used to populate the popup's high-impact alert ladder.
3. `https://aigamma.com/api/narrative?page=/` &ndash; the latest
   AI-generated narrative paragraph for the aigamma.com landing page,
   refreshed every five market-hour minutes by the platform's
   server-side narration worker. Used to populate the narration card at
   the top of the popup.

In the background, a service worker issues only the snapshot request on a
schedule and updates the toolbar icon to reflect the current gamma
regime. The events-calendar and narrative endpoints are never polled in
the background; both are fetched only when the popup is opened. No other
network activity occurs.

## What the extension collects

The extension does not collect, store, or transmit any personal information,
browsing history, cookies, form data, keystrokes, clipboard contents, account
credentials, or information about any tab, site, or account other than its
own popup surface.

The extension has no content scripts and cannot read data from any web page
the user visits. The extension declares no `host_permissions` and has no
ability to observe or modify traffic on any site other than its three
outgoing fetches to aigamma.com.

The extension uses no local storage, no sync storage, no usage analytics
or telemetry, no advertising identifiers, and no third-party SDKs.

## What aigamma.com receives

All three endpoints (`api/snapshot.json`, `api/events-calendar`, and
`api/narrative`) are public, unauthenticated resources. Requests made by
the extension are standard HTTPS requests. The receiving server records
only standard HTTP request metadata (IP address, user agent, timestamp)
as part of normal operational logging. This metadata is not linked to
any user identity, is not retained beyond operational need, and is not
shared with third parties.

## Permissions justification

The extension declares only one permission: `alarms`, used by the background
service worker to schedule periodic fetches of the snapshot endpoint during
market hours. The extension does not declare `host_permissions`, `tabs`,
`activeTab`, `storage`, `cookies`, `scripting`, `webRequest`, or any other
permission. The cross-origin fetches to aigamma.com are permitted because
all three endpoints return CORS headers allowing any origin.

## Data sharing

No data is shared with third parties because no user data is collected.

## Contact

support@aigamma.com
