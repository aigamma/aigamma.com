# Supabase Schema Reference

Project ID: `tbxhvpoyyyhbvoyefggu`. All tables have RLS enabled. Netlify functions use the service-role key (bypasses RLS) for writes and the anon key for reads.

## Core ingest tables (Massive API, real-time intraday)

**ingest_runs** — One row per fetch. PK: `id` (bigserial).
- `underlying` (varchar), `captured_at` (timestamptz), `trading_date` (date)
- `snapshot_type` (varchar, check: intraday | daily | synthetic_backfill)
- `spot_price` (numeric), `contract_count` (int), `expiration_count` (int)
- `source` (varchar, default 'massive'), `status` (varchar, default 'success')
- `duration_ms` (int, nullable), `error_message` (text, nullable)
- FK targets: snapshots, computed_levels, expiration_metrics, svi_fits

**snapshots** — Contract-level data. PK: `id` (bigserial). FK: `run_id` → ingest_runs.
- `expiration_date` (date), `strike` (numeric), `contract_type` (varchar), `root_symbol` (varchar, nullable)
- `implied_volatility`, `delta`, `gamma`, `theta`, `vega` (all numeric, nullable)
- `open_interest` (int), `volume` (int), `close_price` (numeric)
- `bid_price`, `ask_price` (numeric, nullable) — synchronous NBBO at snapshot time

**computed_levels** — Aggregate metrics per run. PK: `id`. FK: `run_id` → ingest_runs (unique).
- `call_wall_strike`, `put_wall_strike`, `abs_gamma_strike`, `volatility_flip` (numeric)
- `atm_call_gex`, `atm_put_gex` (numeric), `atm_contract_count` (int) — ATM-bucket (|δ|∈[0.40, 0.60])
- `put_call_ratio_oi`, `put_call_ratio_volume` (numeric)
- `total_call_oi`, `total_put_oi`, `total_call_volume`, `total_put_volume` (bigint)
- `net_vanna_notional`, `net_charm_notional` (numeric)

**expiration_metrics** — Per-expiration skew. PK: `id`. FK: `run_id` → ingest_runs.
- `expiration_date` (date), `atm_iv`, `atm_strike` (numeric)
- `put_25d_iv`, `call_25d_iv`, `skew_25d_rr` (numeric)
- `contract_count` (int)

**svi_fits** — Gatheral raw-SVI fits + Breeden-Litzenberger density. PK: `id`. FK: `run_id` → ingest_runs.
- `expiration_date` (date), `t_years`, `forward_price` (numeric)
- SVI params: `a`, `b`, `rho`, `m`, `sigma` (numeric)
- `rmse_iv`, `sample_count`, `iterations`, `converged`, `tenor_window`
- Diagnostics: `non_negative_variance`, `butterfly_arb_free`, `min_durrleman_g`
- Density: `density_strikes` (numeric[]), `density_values` (numeric[]), `density_integral`

## Historical / EOD tables (Massive sourced)

**daily_volatility_stats** — EOD vol metrics. PK: `trading_date` (date).
- `spx_open`, `spx_high`, `spx_low`, `spx_close` (numeric)
- `hv_20d_yz` (Yang-Zhang 20d realized vol), `iv_30d_cm` (30d constant-maturity ATM IV)
- `vrp_spread` (iv_30d_cm − hv_20d_yz)
- `sample_count` (int), `computed_at` (timestamptz)

**daily_term_structure** — Per-expiration ATM IV by trading date. Composite PK: `(trading_date, expiration_date)`.
- `dte` (int), `atm_iv` (numeric), `source` (text, check: massive | theta)
- `percentile_rank` (numeric, nullable)

**daily_cloud_bands** — Historical IV percentile bands. Composite PK: `(trading_date, dte)`.
- `dte` (int, check: 0..280)
- `iv_p10`, `iv_p30`, `iv_p50`, `iv_p70`, `iv_p90` (numeric)
- `sample_count` (int), `computed_at` (timestamptz)

**daily_gex_stats** — Daily GEX summary. PK: `trading_date` (date).
- `spx_close`, `net_gex`, `call_gex`, `put_gex` (numeric)
- `vol_flip_strike`, `call_wall_strike`, `put_wall_strike` (numeric)
- `atm_call_gex`, `atm_put_gex`, `atm_contract_count` — ATM-bucket figures
- `contract_count`, `expiration_count` (int), `computed_at` (timestamptz)

**spx_intraday_bars** — 30-minute SPX bars for /seasonality. PK: `(trading_date, bucket_time)`.
- `spx_open`, `spx_high`, `spx_low`, `spx_close` (numeric)
- `source` (varchar), `ingested_at` (timestamptz)

**daily_eod** — Daily EOD OHLC for index and stock symbols. PK: `(symbol, trading_date)`.
- `open`, `high`, `low`, `close` (numeric)
- `source` (text), `ingested_at` (timestamptz)

**vix_family_eod** — VIX family + cross-asset vol benchmarks. PK: `(trading_date, symbol)`.
- `open`, `high`, `low`, `close` (numeric)
- `source` (text, default 'massive'), `ingested_at` (timestamptz)
- Sourced from Massive Indices Starter via scripts/backfill/vix-family-eod.mjs.

## Self-consistency reconciliation

**reconciliation_audit** — Daily self-check probe results. PK: `id` (bigserial).
- `trading_date` (date), `check_name` (text)
- `observed_value`, `expected_value`, `delta_pct` (numeric, nullable)
- `status` (text, check: pass | warn | fail | skip)
- `notes` (text), `reconciled_at` (timestamptz)
- Five probe types written per trading day: `spx_close_xcheck` (Path A intraday spot vs Path B Massive daily aggregate), `run_count`, `partial_rate`, `atm_iv_null_rate`, `late_snapshot`. Populated by netlify/functions/reconcile-background.mjs at ~22:00 UTC weekdays.

## Chat / RAG tables

**chat_logs** — Every chat turn: query, surface, model, retrieved chunks, response, timing, tool uses, stop reason, optional user feedback. PK: `id`.

**chat_rate_limit** — Per-IP per-endpoint per-minute counter for chat rate limiting. Maintained by `check_rate_limit()` RPC; opportunistic cleanup deletes rows older than 1 hour.

**rag_documents** — Unified RAG knowledge store. Chunks of indexed prose with content_hash, tsvector, 384-dim gte-small embedding, JSONB metadata. Read by chat-rag Edge Function via match_rag_chunks + get_system_prompts RPCs; written by rag-ingest Edge Function from the scripts/rag/ingest.mjs walker.
