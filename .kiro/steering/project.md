# aigamma.com — Project Steering

## Platform Architecture

This project is one of two interconnected surfaces under the aigamma.com domain:

- **aigamma.com** — Live SPX volatility dashboard (React/Vite, this repo, deployed on Netlify)
- **about.aigamma.com** — Portfolio and AI chatbot (single-file HTML, repo: aigamma/about.aigamma.com, deployed on Netlify)

Both sites share a top-row nav bar linking to each other. Visual consistency matters: dark theme, Calibri-style sans-serif body type, the four-token color palette (accent-blue #4a9eff, accent-coral #d85a30, accent-amber #f0a030, accent-green #2ecc71), transparent paper with #141820 plot backgrounds.

## Data Layer

Massive is the single source of all market data feeding the dashboard. The pipeline has two layers:

**Real-time intraday.** A scheduled Netlify Function (ingest-background.mjs) fetches SPX options chains from the Massive API every 5 minutes during market hours, computes GEX and positioning metrics, and writes to four Supabase tables: ingest_runs, snapshots, computed_levels, and expiration_metrics. The frontend reads from Supabase through a separate Netlify Function (data.mjs) with a 900-second CDN cache. The browser never contacts Massive or Supabase directly.

**Historical EOD.** Massive Indices Starter feeds vix_family_eod (VIX family + cross-asset vol + skew benchmarks). Massive Stocks Starter feeds daily_eod (single-name and sector ETF OHLC for /rotations, /heatmap, /stocks, /sector-performance, /stock-performance). SPX EOD, the term structure, cloud bands, intraday SPX bars, and daily GEX history (daily_volatility_stats, daily_term_structure, daily_cloud_bands, spx_intraday_bars, daily_gex_stats) are derived from Massive: index EOD where available, daily downsamples of the existing intraday `snapshots` and `expiration_metrics` rows where the underlying chain data is already in Supabase.

**Self-consistency reconciliation.** A scheduled Netlify Function (reconcile-background.mjs, dispatched by reconcile.mjs at 22:00 UTC weekdays) records five daily probes into public.reconciliation_audit. Path A is the closing intraday snapshot's spot price; Path B is the Massive daily aggregate I:SPX close. The probes also cover run-count completeness, partial-fetch rate, expiration_metrics atm_iv null rate, and lateness of the day's last successful snapshot. The system is single-vendor — divergence between Path A and Path B catches spot-inference bugs, snapshot-time drift, and trading_date misassignment, but a vendor-side normalization change would land identically in both paths and is out of scope for this audit.

The Supabase database (project ID: tbxhvpoyyyhbvoyefggu) is the persistence layer for everything.

### Data Redistribution Boundaries

Massive's vendor terms prohibit republishing raw contract-level data: per-strike IV, per-contract Greeks, individual bid/ask quotes across the full options chain. That is the vendor's commercial product and must not be displayed in raw form on the public site.

The following are explicitly permitted for public display and should not be gated or flagged:

- **SPX index OHLC.** Cash-settled SPX open/high/low/close quotes that CBOE publicly disseminates can be displayed on charts and in hover tooltips without being considered vendor redistribution. This is a display permission, not an ingestion permission — see Data Provenance below for the sole-source rule.
- **Single-point derived metrics.** Computed ATM IV, 25-delta put/call IV, realized volatility, expected move, P/C ratios, and any other scalar value computed from the chain. These are transformative analytical outputs.
- **Model outputs.** Regime labels, percentile ranks, calibration scores, GEX profiles, Vol Flip levels, Put/Call Wall levels, Breeden-Litzenberger densities, SVI parameters, term structure curves.
- **Historical time series of any of the above.**

The test: could a user reconstruct the raw options chain from what is displayed? If no, it is fine to show. The raw chain is consumed locally, processed, and discarded — only computed outputs persist in Supabase.

### Data Provenance

Massive is the sole source of all index, options, and stock data that lands in Supabase. Do not scrape or ingest from Yahoo Finance, FRED, Google Finance, Stooq, brokerage feeds, or any other public source to fill historical gaps, even for apparently innocuous fields like SPX daily close. This rule is absolute and overrides any argument that a particular field is "universally public" or "just a reference price."

The reason is consistency, not licensing. A single-vendor pipeline guarantees that every row — intraday snapshots, EOD index quotes, derived metrics, term structure points — observes one normalization, one corporate-action convention, one settlement-window cutoff, and one adjustment ruleset. Blending a Yahoo close with a Massive options chain on the same calendar date does not produce a coherent snapshot; it produces two adjacent snapshots of subtly different markets, and the difference leaks into every downstream computation as noise that model code cannot distinguish from a real regime shift.

When a Massive tier wall creates a historical gap, the gap is the truthful answer. Write null, leave the table sparse, and surface that sparseness honestly. Do not propose alternate-source backfills. The only acceptable way to extend history is to upgrade the Massive tier; everything else is contamination.

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
