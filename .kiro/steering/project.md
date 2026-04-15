# aigamma.com — Project Steering

## Platform Architecture

This project is one of two interconnected surfaces under the aigamma.com domain:

- **aigamma.com** — Live SPX volatility dashboard (React/Vite, this repo, deployed on Netlify)
- **about.aigamma.com** — Portfolio and AI chatbot (single-file HTML, repo: aigamma/about.aigamma.com, deployed on Netlify)

Both sites share a top-row nav bar linking to each other. Visual consistency matters: dark theme, Courier New monospace, the four-token color palette (accent-blue #4a9eff, accent-coral #d85a30, accent-amber #f0a030, accent-green #2ecc71), transparent paper with #141820 plot backgrounds.

## Data Layer

There are two independent data sources feeding the dashboard:

**Massive API (real-time intraday).** A scheduled Netlify Function (ingest-background.mjs) fetches SPX options chains from the Massive API every 5 minutes during market hours, computes GEX and positioning metrics, and writes to four Supabase tables: ingest_runs, snapshots, computed_levels, and expiration_metrics. The frontend reads from Supabase through a separate Netlify Function (data.mjs) with a 900-second CDN cache. The browser never contacts Massive or Supabase directly.

**ThetaData (historical EOD).** The Theta Terminal V3 runs locally as a Java process and hosts a REST API at http://127.0.0.1:25503/v3. The subscription tier is Options Standard, Stock Free, Index Free. The terminal authenticates against ThetaData's FPSS server on startup using credentials stored in a local creds.txt file. Subscription tier changes require a terminal restart and may take multiple restarts to propagate due to backend cache behavior on ThetaData's side.

### ThetaData Subscription Access (Options Standard)

Available historical endpoints at the current tier:

- **Options EOD** — option/history/eod (all tiers)
- **Options Quote** — option/history/quote (Value+)
- **Options Open Interest** — option/history/open_interest (Value+)
- **Options OHLC** — option/history/ohlc (Value+)
- **Options Implied Volatility** — option/history/greeks/implied_volatility (Standard+)
- **Options First Order Greeks** — option/history/greeks/first_order (Standard+), returns delta, gamma, theta, vega, rho
- **Options EOD Greeks** — option/history/greeks/eod (Standard+), returns full EOD report with OHLC, NBBO, first order Greeks, IV, underlying price, d1, d2, iv_error
- **Index EOD** — index/history/eod (all tiers)

Not available at Standard (requires Pro): second/third order Greeks, trade-level Greeks, options history before 2016-01-01.

Key query patterns:

- Setting expiration=* returns data for every listed option on a symbol for a single date. Wildcard queries must be requested day by day, not across date ranges.
- The rate_type parameter on Greeks endpoints accepts sofr (default) or Treasury tenors from 1-month to 30-year. A custom rate can be passed via rate_value.
- The version parameter controls 0DTE Greeks handling: "latest" uses real time-to-expiry down to 1 hour minimum; "1" uses a fixed 0.15 DTE.
- The iv_error field in EOD Greeks responses is the ratio of the BSM-reconstructed option price to the actual quoted price.
- Max concurrent requests at Standard: 2 threads. Historical depth: back to 2016-01-01.

The Supabase database (project ID: tbxhvpoyyyhbvoyefggu) serves as the persistence layer for both data sources.

### Data Redistribution Boundaries

Market data vendor terms (ThetaData, Massive) prohibit republishing raw contract-level data: per-strike IV, per-contract Greeks, individual bid/ask quotes across the full options chain.

The following are explicitly permitted for public display — do not gate or add caveats to these:

- **Universally public reference data.** SPX daily close prices (disseminated by CBOE, available from FRED/Yahoo/Google).
- **Single-point derived metrics.** Computed ATM IV, 25-delta put/call IV, realized volatility, expected move, P/C ratios, and any scalar computed from the chain.
- **Model outputs.** Regime labels, percentile ranks, calibration scores, GEX profiles, Vol Flip levels, Put/Call Wall levels, Breeden-Litzenberger densities, SVI parameters, term structure curves.
- **Historical time series of any of the above.**

The test: could a user reconstruct the raw options chain from what is displayed? If no, it's fine to show. The raw chain is consumed locally, processed, and discarded — only computed outputs persist in Supabase and render on the site.

## Repos and Domains

- GitHub: github.com/aigamma/aigamma.com → Netlify project "aigamma" → aigamma.com
- GitHub: github.com/aigamma/about.aigamma.com → Netlify project "aboutaigamma" → about.aigamma.com
- DNS for both domains managed by Netlify. MX, SPF, DKIM, and DMARC records serve Google Workspace email at aigamma.com. Do not touch email-related DNS records.

## Environment Variables

See .env.example in the project root for the full list. Never commit actual values.

## Commits

Always commit and push after making changes. Do not hesitate — changes can always be rolled back and the owner keeps extensively redundant backups on multiple physical and virtual drives, in addition to GitHub history. Commit message style: verbose, past tense, ending with a period.

## Tech Stack

- React + Vite frontend
- Netlify Functions (ESM .mjs) for backend/serverless
- Supabase (Postgres) for persistence
- Plotly for charts
- Three.js for 3D vol surface
