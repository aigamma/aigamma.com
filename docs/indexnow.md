# IndexNow integration for aigamma.com

This document is the canonical reference for the IndexNow integration that pushes the site's URL list to Bing's IndexNow API on every successful production deploy. Read it end-to-end before changing any of the components below.

## What IndexNow does

IndexNow is a unified push notification protocol that lets a publisher tell participating search engines that a URL has changed without waiting for the engine's crawler to discover it on its own schedule. A single POST to `https://api.indexnow.org/indexnow` reaches Bing, Yandex, Naver, Seznam, and other IndexNow.org-aligned indices simultaneously; one submission per deploy keeps every participating engine in lockstep with the live site without requiring per-engine wiring or per-engine credentials. There is no equivalent for Google (Google does not participate in IndexNow), so this integration covers the Bing-family / Yandex-family stack only and is not a substitute for whatever Google-specific surface aigamma.com may want to maintain in parallel.

## Topology

The integration has four cooperating pieces, all in this repo:

```
Successful Netlify deploy
  └─ netlify/plugins/indexnow (onSuccess hook)
       └─ reads dist/sitemap.xml (emitted by sitemapPlugin in vite.config.js)
       └─ POSTs <loc> entries to https://api.indexnow.org/indexnow
            └─ keyLocation field points at https://aigamma.com/<key>.txt
                 └─ verification file shipped from public/<key>.txt
```

1. **`vite.config.js` `sitemapPlugin()`** — emits `dist/sitemap.xml` at build time from the canonical `PAGES` registry in `src/data/pages.js`. Sandboxes (`/alpha/`, `/beta/`, `/dev/`) are excluded; the rest of the site (homepage + 17 lab/tool pages + disclaimer = 19 URLs at time of writing) lands in the sitemap. Adding or removing a page is a one-file edit in `pages.js` and the next build automatically reflects the change in the sitemap.
2. **`public/<INDEXNOW_API_KEY>.txt`** — the 32-character lowercase-hex verification file required by the IndexNow protocol. Vite's static asset pipeline copies it from `public/` into `dist/` at build time so it ships with every deploy and is reachable at `https://aigamma.com/<key>.txt`. The file contents must be the bare key string with no trailing newline (32 bytes exactly).
3. **`netlify/plugins/indexnow/`** — the local Netlify Build Plugin (`manifest.yml` + `index.js`) registered in `netlify.toml` that runs in the `onSuccess` build phase. Reads `dist/sitemap.xml`, parses `<loc>` entries with a single regex `matchAll`, and POSTs them to `https://api.indexnow.org/indexnow` in batches of up to 10000 URLs per request (the protocol's documented per-call maximum).
4. **`scripts/indexnow-test.js`** — a one-shot exerciser that POSTs a single test URL using the same plumbing the build plugin uses. Useful for verifying credentials and the verification file are wired up correctly without waiting for a deploy.

## Required environment variables

Both must be set in the Netlify UI under **Site settings → Environment variables**, never in code or `netlify.toml`. The build plugin fails fast (via `utils.build.failPlugin`) if either is missing, so a misconfigured site fails its first deploy with a clear message rather than silently skipping IndexNow submissions.

- `INDEXNOW_API_KEY` — the 32-character lowercase-hex key matching the verification file at `public/<key>.txt`. Constraints (per the IndexNow spec): 8–128 characters, lowercase a–z + digits 0–9 + hyphens only. The current key is `574cfbd6990f432492f46ab622486967`.
- `SITE_HOST` — the bare host, no scheme, no path. For aigamma.com this is `aigamma.com`. The plugin assembles `https://${SITE_HOST}/${INDEXNOW_API_KEY}.txt` as the `keyLocation` field of every IndexNow submission, which Bing fetches asynchronously to verify the publisher owns the host before processing the URL list.

For local testing, the same two variables go in `.env.local` (which is gitignored) so `node --env-file=.env.local scripts/indexnow-test.js` picks them up.

## Verification flow

1. Set `INDEXNOW_API_KEY` and `SITE_HOST` in the Netlify UI under Site settings → Environment variables.
2. Push the IndexNow integration to `main`. The next deploy ships the verification file at `https://aigamma.com/<key>.txt` and runs the IndexNow plugin in `onSuccess`.
3. Confirm the verification file is publicly readable:
   ```
   curl -i https://aigamma.com/574cfbd6990f432492f46ab622486967.txt
   ```
   Expected: HTTP 200 with response body equal to the key string (32 bytes, no trailing newline).
4. In the Netlify deploy log, look for a `[indexnow]` line near the end of the `onSuccess` phase reporting the number of URLs submitted and the HTTP status. A line like `[indexnow] Successfully submitted 19 URLs in 1 batch(es) to https://api.indexnow.org/indexnow.` means the build-time submission succeeded.
5. In **Bing Webmaster Tools** (`https://www.bing.com/webmasters/`), navigate to the verified property for aigamma.com → **IndexNow Insights** in the left nav. Submitted URLs from the deploy should appear there within a few minutes; the report shows the count of URLs submitted, accepted, and any rejected with reasons. Bing also surfaces aggregate statistics for the rolling 30-day window so deploy-over-deploy submission counts can be tracked.
6. To exercise the submission plumbing without waiting for a deploy, run the test script locally:
   ```
   node --env-file=.env.local scripts/indexnow-test.js
   ```
   A `HTTP 202 Accepted` response means the request structure and credentials are validated by Bing's frontend (the actual key-file fetch happens async). A `HTTP 403` means the verification file at `https://<SITE_HOST>/<INDEXNOW_API_KEY>.txt` is not publicly readable; deploy the site first so the file ships at the expected URL, then re-run.

## Disabling the plugin

Comment out the `[[plugins]]` block at the bottom of `netlify.toml`:

```toml
# [[plugins]]
#   package = "/netlify/plugins/indexnow"
```

Subsequent deploys complete normally with no IndexNow side effects. The verification file stays live at `https://aigamma.com/<key>.txt`, and the sitemap continues to be generated by Vite (since the sitemapPlugin is independent and useful for SEO regardless of IndexNow). To remove every trace of the integration, additionally delete `netlify/plugins/indexnow/`, `scripts/indexnow-test.js`, the verification file at `public/<key>.txt`, and the `INDEXNOW_API_KEY` + `SITE_HOST` env vars from the Netlify UI.

## Failure modes and recovery

The plugin treats any non-2xx response from `api.indexnow.org` as a build failure via `utils.build.failPlugin`, which surfaces the failure in the Netlify deploy log and prevents an IndexNow regression from going silently unnoticed. The most common failure modes:

- **`INDEXNOW_API_KEY` or `SITE_HOST` env var missing** — set them in the Netlify UI and re-deploy. The plugin's failPlugin message names the missing variable explicitly.
- **`dist/sitemap.xml` missing** — the sitemapPlugin in `vite.config.js` did not run, or the publish directory disagrees with what `constants.PUBLISH_DIR` reports. Check that `vite.config.js` still registers `sitemapPlugin()` in the `plugins:` array and that the build log shows a `dist/sitemap.xml` line with a non-zero size.
- **HTTP 403 from api.indexnow.org** — the verification file at `https://<SITE_HOST>/<INDEXNOW_API_KEY>.txt` is missing or not publicly readable, or its contents do not match `INDEXNOW_API_KEY`. Verify `public/<key>.txt` exists with exactly the key string and re-deploy. The failPlugin message includes this hint.
- **HTTP 422 from api.indexnow.org** — usually means a URL in the sitemap does not belong to the host claimed in the `host` field, which would happen if `SITE_HOST` were set to something other than `aigamma.com` while the sitemap continues to point at `https://aigamma.com/...`. Reconcile the two.
- **Network error before any response** — a transient DNS or connection failure to `api.indexnow.org`. Re-deploy; if it recurs across multiple deploys, check Netlify's outbound network status and consider whether `api.indexnow.org` is reachable from Netlify's build infrastructure region.

## When to re-submit by hand

The build plugin re-submits on every successful deploy, so the steady-state cadence is whatever the deploy cadence is. Bing's IndexNow protocol explicitly tolerates re-submission of unchanged URLs without penalty (the engine deduplicates internally), so there is no harm in deploying a documentation-only change and triggering a full re-submission as a side effect. There is no "manual submit one URL" affordance built into the integration; if a one-off URL submission is needed (e.g., to re-prompt re-indexing of a single page after an external event), use the test script with the URL list edited inline.

## Why no Google equivalent

Google does not participate in IndexNow. The closest equivalent for Google is Search Console's Indexing API, which has stricter eligibility requirements (job postings and live broadcast events only as of this writing), and the URL Inspection tool which requires an interactive operator. Neither maps cleanly to a build-time deploy hook for a general-purpose dashboard site, so this integration is intentionally Bing-family-only and Google indexing continues to depend on Googlebot's crawl schedule, the sitemap.xml advertised in robots.txt, and any explicit URL submissions an operator does through Search Console.
