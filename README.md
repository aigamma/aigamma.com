# aigamma.com

Open-source quantitative volatility dashboard for SPX options, built with React, Plotly, and live OPRA data. MIT license.

Production deployment: https://aigamma.com

## What This Is

A quantitative finance platform that visualizes gamma exposure, implied volatility structure, dealer positioning, and volatility risk premium for SPX options. The dashboard consumes real-time options chain snapshots every 5 minutes during market hours, computes GEX per strike, derives key levels (Call Wall, Put Wall, Absolute Gamma Strike, Volatility Flip), fits SVI volatility surfaces, extracts Breeden-Litzenberger risk-neutral densities, and renders interactive Plotly charts on a dark-themed interface.

Historical analysis is powered by EOD data layers ingested from the same vendor as the live chain, enabling percentile-banded term structure visualization, volatility risk premium modeling, and regime detection. A daily self-consistency reconciliation job verifies the closing intraday snapshot against the vendor's daily aggregate endpoint and audits the day's intraday run completeness.

This project independently reconstructs the category of tooling offered by institutional derivatives analytics platforms, using serverless infrastructure entirely.

## Architecture

The system separates real-time data collection, historical data, self-consistency auditing, and data serving into independent layers.

**Intraday Layer.** A scheduled Netlify Function (ingest-background.mjs) fetches the full SPX options chain from the Massive API every 5 minutes during market hours. It computes GEX and positioning metrics and writes to four Supabase tables: ingest_runs, snapshots, computed_levels, and expiration_metrics. The frontend reads from Supabase through a separate Netlify Function (data.mjs) with a 900-second CDN cache. The browser never contacts the data source directly.

**Historical Layer.** A set of EOD tables (daily_volatility_stats, daily_term_structure, daily_cloud_bands, daily_gex_stats, spx_intraday_bars, daily_eod, vix_family_eod) is fed from Massive. Index EOD lands via direct daily-aggregate calls; SPX-specific tables (term structure, cloud bands, GEX history) are derived from daily downsamples of the intraday snapshots and expiration_metrics already in Supabase. Stock and sector ETF OHLC for /rotations, /heatmap, /stocks, /sector-performance, and /stock-performance comes from Massive Stocks Starter.

**Reconciliation Layer.** A daily reconciliation job (netlify/functions/reconcile-background.mjs) runs at 22:00 UTC weekdays and records five self-consistency probes into public.reconciliation_audit. The headline probe is a Path-A-vs-Path-B cross-check: the closing intraday snapshot's inferred spot price (Path A) against Massive's I:SPX daily aggregate close (Path B). The other four probes audit completeness of the day's intraday runs (run count, partial-fetch rate, atm_iv null rate, lateness of the final snapshot). Single-vendor by design; the goal is to catch ingestion-side bugs (spot inference regressions, snapshot-time drift, schema misassignment) rather than vendor-side data quality.

CDN edge caching absorbs read traffic, so Supabase sees approximately one query per edge location per cache window regardless of concurrent user count.

## Models

**Gamma Exposure.** GEX per strike with symlog scaling, dealer gamma inflection profile, and gamma response map.

```
GEX_contract = gamma * open_interest * 100 * spot_price^2 * 0.01
Net_GEX(K)  = sum(call GEX at K) - sum(put GEX at K)
```

Sign convention follows dealer positioning: calls create positive gamma (stabilizing), puts create negative gamma (destabilizing), assuming dealers are net short options.

**Key Levels.** Derived from the GEX profile:
- **Call Wall**: Strike with highest positive call gamma notional
- **Put Wall**: Strike with highest negative put gamma notional
- **Absolute Gamma Strike**: Strike with highest total absolute gamma (strongest pinning effect)
- **Volatility Flip**: Interpolated net-GEX zero crossing where the absolute exposure on both sides is largest, the structurally dominant regime boundary between positive and negative dealer gamma

**Term Structure with Probability Cloud.** ATM IV across expirations with historical percentile bands computed from a 1-year rolling lookback. Four equal-probability bands (p10-p30, p30-p50, p50-p70, p70-p90) with darkest shading at the extremes and lightest at the median. Dots tinted amber below p30 and coral above p70 as mean-reversion signals.

**SVI Volatility Surface.** 3D interactive surface fit using Stochastic Volatility Inspired parameterization across all listed expirations. Toggle between SVI fit and raw scatter.

**Breeden-Litzenberger Risk-Neutral Density.** Implied probability distribution extracted from the second derivative of call prices with respect to strike, rendered across multiple expirations.

**Fixed-Strike IV Heatmap.** IV across strikes and expiration dates with color-coded intensity.

**Volatility Risk Premium.** 30-day constant-maturity ATM IV versus 20-day Yang-Zhang realized volatility with SPX price overlay. Green shading where IV exceeds HV (positive VRP, normal state), coral shading where HV exceeds IV (negative VRP). Brush-zoom with 6-month default view.

## Database Schema

| Table | Purpose |
|-------|---------|
| ingest_runs | Intraday ingest execution metadata |
| snapshots | 5-minute options chain snapshots |
| computed_levels | Intraday derived levels (PW, CW, VF) |
| expiration_metrics | Per-expiration intraday metrics |
| daily_term_structure | Per-tenor ATM IV history, one row per (trading_date, expiration_date) |
| daily_cloud_bands | Frozen percentile bands (p10/p30/p50/p70/p90) per (trading_date, DTE) |
| daily_volatility_stats | Yang-Zhang realized vol, constant-maturity IV, and VRP spread |
| daily_gex_stats | Daily GEX summary (net/call/put GEX, walls, vol flip) |
| spx_intraday_bars | 30-minute SPX bars for the /seasonality lab |
| daily_eod | Index and stock symbol daily OHLC for cross-asset and stock surfaces |
| vix_family_eod | VIX family + cross-asset vol + skew benchmarks |
| reconciliation_audit | Daily self-consistency probe log |

## Stack

| Component | Role |
|-----------|------|
| React 19 + Vite | Frontend framework |
| Plotly.js + Three.js | Chart rendering (2D and 3D) |
| Netlify | Hosting, CDN, scheduled functions, DNS |
| Supabase Pro | PostgreSQL persistence, RPC, and caching |
| Massive API | Real-time options chain snapshots, daily index/stock aggregates (OPRA-sourced) |

## Development

```bash
git clone https://github.com/aigamma/aigamma.com.git
cd aigamma.com
npm install
npm run dev
```

The dev server runs at localhost:5173. The API proxy (/api/data) only functions on Netlify, so local development shows a loading state unless you configure a local data source. See scripts/backfill/ for the historical data pipeline.

## Related Sites

- **about.aigamma.com**: Portfolio and AI chatbot (repo: aigamma/about.aigamma.com)

## License

MIT. The code is free. The expertise is what employers are hiring.

## Author

Eric Allione / AI Gamma / Prescott, AZ
Revenue Systems Architect
