# Earnings Lab — Data Roadmap

This document captures the strategic data work that surrounds the
`/earnings` lab page. Written 2026-04-26 after the v0.4 chart-filter
toggles shipped (Top 100 OV / Top 250 OV / Rev ≥ $5B / Rev ≥ $1B / Rev
≥ $500M, plus a disabled "Market Cap" placeholder); the toggles fix
the immediate "300 dots is illegible" problem, but the third filter
dimension and several supporting data lanes remain unbuilt. Each
section below is a discrete piece of work with a sketch of the
schema, the upstream data source, the latency / cost profile, and an
honest assessment of when a manual workflow is sufficient and when
automation pays for itself.

## 1. Market cap as a third filter dimension

**Why:** The current toggles cover (a) options-liquidity ranking and
(b) revenue floors. Market cap is the natural third dimension because
it captures index-relevance for SPX vol regime reading in a way
revenue does not — REITs and consumer-staples conglomerates can have
$50B revenue with $20B market cap, while META has $50B revenue and
$1.5T market cap. A reader watching for "names that move the SPX"
wants market cap, not revenue.

**Data source.** Massive (Polygon-compatible) exposes
`/v3/reference/tickers/{ticker}` which returns
`share_class_shares_outstanding`, `weighted_shares_outstanding`, and
`market_cap` (string-encoded, computed from latest closing price ×
shares outstanding) under the `results` object. Stocks Starter
entitlement covers this endpoint. Per-ticker call cost — 1 request
per name — but shares outstanding only changes on quarterly 10-Q
filings, so the result is cacheable for ~quarterly refresh cadence.

**Schema decision.** Two options:

1. **Static roster augmentation.** Add a `marketCap` field to
   `src/data/options-volume-roster.json`, populated by extending
   `scripts/backfill/options-volume-roster.mjs` to call
   `/v3/reference/tickers/{ticker}` for every roster symbol after the
   Barchart CSV is parsed. ~250 calls at ~100 ms each = ~25 seconds
   one-shot. Refresh cadence: weekly (when the Barchart CSV is
   refreshed) or quarterly (when 10-Q filings update shares
   outstanding). Storage: in-repo JSON, no Supabase.

2. **Supabase table.** New table `equity_market_caps` keyed by
   `(ticker, snapshot_date)` with columns `market_cap`,
   `shares_outstanding`, `last_close`, `source`. Refreshed nightly
   by a scheduled function. Storage: Supabase, queryable from any
   function.

**Recommendation: option 1 first.** The roster JSON is already the
source of truth for /scan and /heatmap; threading market cap through
the same file keeps the data model tight and saves the Supabase
table for the more dynamic IV-rank dataset below. If a future page
needs intra-week market cap (live tracking), upgrade to option 2.

**Implementation cost.** ~30 lines in
`scripts/backfill/options-volume-roster.mjs`, ~3 lines in
`netlify/functions/earnings.mjs` to surface `marketCap` per ticker
when it's looked up by symbol against the roster, plus a new toggle
mode `mcap-100B` / `mcap-25B` / `mcap-5B`. Half-day of work.

**Blocked by:** none. Can ship next session.

## 2. IV rank backfill (cross-cutting site asset)

**Why:** Eric flagged this as "helpful for a wide range of the models
on this site." Implied volatility rank — where today's ATM IV sits
within the trailing 1-year range — is the standard vol-regime
indicator across vol desks. Currently the dashboard only exposes IV
at single points in time; an IV rank time series unlocks:

- "/earnings shows AAPL implied range = 3.5%, but its IV rank is at
  the 95th percentile so the chart-day range is rich vs history."
- /scan call/put-skew quadrants annotated by IV rank so the reader
  knows whether the displayed skew lives in a high-vol or low-vol
  regime.
- /tactical, /seasonality, /rotations cross-references for vol-aware
  factor studies.
- Future: a dedicated /iv-rank dashboard page.

**Schema.** Supabase table `iv_rank_daily`:

```sql
create table iv_rank_daily (
  ticker text not null,
  trading_date date not null,
  atm_iv numeric not null,           -- 30D ATM IV, decimal (0-5)
  iv_rank_1y numeric,                 -- (current - 1Y_min) / (1Y_max - 1Y_min) × 100
  iv_percentile_1y numeric,           -- pct of trailing 252 sessions where IV < current
  iv_high_1y numeric,
  iv_low_1y numeric,
  source text not null,               -- 'massive' (only path going forward)
  primary key (ticker, trading_date)
);
create index iv_rank_daily_ticker_date on iv_rank_daily (ticker, trading_date desc);
```

**Data source: Massive Options Starter** ($30/mo, not yet subscribed
on this account). Massive's options daily aggregate endpoints provide
per-contract historical Greeks and IV at the Options Starter tier;
the existing Stocks Starter and Indices Starter tiers do not cover
per-contract historical options Greeks. Subscribing to Options
Starter is the gating step for this backfill. Once entitled:

- A historical daily-aggregate fetch per ticker per date returns
  per-contract OHLC and (at the Options tier) computed IV / Greeks.
  ATM IV is picked at the strike nearest spot for the soonest
  expiration in [21D, 45D] DTE — same convention as /scan.
- Daily incremental update: ~250 calls at Options Starter's
  unmetered call budget. Estimated wall: a few minutes per day.
- Backfill window depends on Options Starter's historical depth
  (verify on subscribe; Massive Indices Starter offers 1+ year, the
  options tier is documented similarly).

**Latency / cost profile.** $30/mo for the Options Starter tier is
the marginal cost. No local terminal dependency — runs entirely as a
Netlify function against the remote Massive API. Storage in
Supabase: ~250 rows/day × ~252 trading days × ~5 years ≈ ~315k rows
× ~80 bytes/row ≈ ~25 MB, well within the free tier.

**Computation.** IV rank and percentile are derived on insert from
the trailing 252 trading days of `atm_iv`:

```js
const trailing = await selectTrailing(ticker, tradingDate, 252);
const ivs = trailing.map(r => r.atm_iv).sort((a,b) => a-b);
const min = ivs[0];
const max = ivs[ivs.length - 1];
const rank = (current - min) / (max - min) * 100;
const pct = ivs.filter(x => x < current).length / ivs.length * 100;
```

**Implementation cost.** New script
`scripts/backfill/iv-rank-backfill.mjs` (~150 lines: Massive
options-aggregate ATM-IV resolver, Supabase writer, chunked walker,
resume-from-state prompt template per the auto-memory feedback). New
scheduled function `netlify/functions/iv-rank-ingest.mjs` (~80
lines: fires nightly at 9 PM ET, writes today's row + recomputes the
trailing window for every roster ticker). 1-2 days of work + a
shorter wall-clock window than the previous local-terminal plan.

**Blocked by:**
- Massive Options Starter subscription ($30/mo) — confirm coverage
  of per-contract historical Greeks/IV before subscribing.
- Supabase migration must be applied to the production project
  (`tbxhvpoyyyhbvoyefggu`) before the function deploys.
- Roster (`src/data/options-volume-roster.json`) must be the
  authoritative ticker list; ~250 names is the right scope.

## 3. Options-volume ranking automation

**Why:** Currently the roster JSON is regenerated manually from a
Barchart "stocks screener" CSV that Eric pulls weekly to
`C:\sheets\`. The script
`scripts/backfill/options-volume-roster.mjs` reads that CSV and
writes the JSON. Manual cadence works but means ranking shifts only
catch up at refresh time, and the source CSV is gated by a Barchart
account. Two automation paths:

**Path A: compute from Massive grouped options aggregates.** Massive
`/v2/aggs/grouped/locale/us/market/options/{date}` returns daily
volume for every options contract on a date. Aggregating volume
across all contracts per underlying gives the per-ticker daily
options volume; rolling 30-day average gives the ranking. Cost: 1
Massive call per day, parsed to ~250 ticker rankings. Latency: ~2 s
per day. Blocked by: confirming the grouped-options endpoint is on
Massive's Stocks Starter or Options Starter tier (likely Options
Starter, which is a separate subscription).

**Path B: schedule the manual Barchart pull.** Keep the existing
script, schedule it as a weekly Tuesday-morning Netlify scheduled
function that downloads the latest CSV from Barchart's screener URL
(if the URL structure is stable / the screener allows
unauthenticated CSV export — likely needs cookies or a saved
screener config). Lower priority than path A because the data lane
stays manual-touched.

**Recommendation: defer until path A is needed for IV rank.** The
current weekly manual cadence is fine for a roster that shifts
slowly. Revisit if and when IV-rank consumers want a more dynamic
universe.

**Blocked by:** Options Starter tier or upgraded Massive subscription
(if path A); stable Barchart CSV download URL (if path B). Not
urgent.

## 4. Databento evaluation

**Why:** Eric noted Databento as a possible alternative data lane
for IV history and options volume, but flagged it doesn't have an
MCP server yet. Databento is a high-quality market data provider —
historical and live options trades, NBBO quotes, and computed
greeks/IV. Their MBP-10, MBO, and OPRA full feeds are richer than
Massive's snapshot API, with sub-second latency on real-time and
microsecond-resolution historical playback.

**When it pays.** Databento is the right choice when:
- Sub-second realtime options flow becomes a feature (e.g., a real-
  time gamma flow scanner). Massive's 5-minute snapshot cadence
  isn't enough.
- Deeper or earlier historical OPRA depth than Massive's tiers
  expose. Databento's OPRA history goes back further and includes
  microsecond-resolution depth data.
- Tick-level options flow analysis (gamma exposure tape, dealer
  positioning hypothesis testing). Massive aggregates; Databento
  preserves trade-level detail.

**When Massive is sufficient.** Massive Indices Starter + Stocks
Starter covers everything the dashboard currently shows. Adding
Options Starter ($30/mo) covers the IV rank backfill above. Until
the sub-second / deep-history / tick-flow use cases mature, the
Massive tier ladder is the right place to spend the next dollar.

**Cost gate.** Databento is metered per byte transferred. A full
options chain history pull would be substantially more expensive
than Massive's flat-rate tier ladder. Worth a 1-week trial when one
of the three triggers above lands.

**MCP scriptability.** Eric noted Databento has no MCP server but is
"scriptable on my own if that kind of extra data lane would be
necessary." Confirmed — Databento has Python and Rust SDKs and a
plain HTTPS API. A custom integration would mirror the existing
Massive ingest pattern (Netlify function fetches in chunks, writes
to Supabase). MCP convenience would be a nice-to-have for ad-hoc
exploration but not a blocker for backfill scripts.

**Recommendation: don't subscribe yet.** Capture this evaluation in
the roadmap so the next time a model needs sub-second flow or
deeper-history options data, the decision tree is already drawn.
Until then, the Massive tier ladder is sufficient for /earnings and
the broader dashboard.

## Summary table

| Item | Status | Source | Cost | Trigger |
|---|---|---|---|---|
| Market cap filter | Stub in UI, not built | Massive `/v3/reference/tickers` | Half-day work | When user wants it |
| IV rank backfill | Designed, not built | Massive Options Starter ($30/mo) | 1-2 days work after subscription lands | High-leverage cross-cutting asset; recommend next |
| Options volume automation | Manual works, deferred | Massive grouped options OR Barchart CSV | TBD | Only if IV-rank consumers need dynamic universe |
| Databento subscription | Not subscribed | Databento APIs | Metered, $1k+/mo for full history | Only if sub-second flow / deep-history options needed |

## Sequencing

The recommended order if all four are pursued:

1. **Market cap filter** (half-day) — finishes the chart toggle UX
   the placeholder pill in the UI is already advertising.
2. **IV rank backfill** (1-2 days work, 4 nights wall) — the
   highest-leverage of the four. Unlocks vol-regime context across
   the entire dashboard, not just /earnings.
3. **Options volume automation** (deferred) — only worth doing once
   IV-rank consumers want a dynamic universe.
4. **Databento subscription** (deferred) — only worth doing for a
   specific feature (sub-second flow scanner or deep-history options
   data) that Massive's tier ladder can't deliver.
