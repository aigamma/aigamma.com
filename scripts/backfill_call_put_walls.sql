-- Backfill call_wall_strike and put_wall_strike in computed_levels using the
-- corrected signed-net GEX formula. Previous logic picked the strike with the
-- highest gross call gamma and the highest gross put gamma independently, so a
-- single strike with massive gamma on both sides could win both titles (the
-- symptom that triggered this fix: SPX runs 16-19 all reported 7000 for both).
--
-- Corrected definitions:
--   Call Wall = argmax over strikes of (callGex - putGex) — the strike where
--               calls dominate puts by the widest positive margin.
--   Put  Wall = argmin over strikes of (callGex - putGex) — the strike where
--               puts  dominate calls by the widest positive margin
--               (equivalently, the most negative net GEX).
--
-- GEX per contract uses the same formula as the live Compute GEX node:
--   gex = gamma * open_interest * 100 * spot * spot * 0.01
--
-- Tiebreaker (matches the JS loop in n8n/workflow.mjs COMPUTE_GEX_JS): when
-- two strikes share the extremum, prefer the lower strike. The JS loop walks
-- strikes in ascending order with strict > and < comparisons, so the first
-- strike to hit the target wins; ORDER BY ... ASC as the secondary key
-- reproduces that.
--
-- Idempotent: the final UPDATE only touches rows whose (call_wall_strike,
-- put_wall_strike) pair actually differs from the recomputed pair.
--
-- Run against the aigamma-dev Supabase project (id: tbxhvpoyyyhbvoyefggu).

WITH strike_gex AS (
  SELECT
    s.run_id,
    s.strike,
    COALESCE(SUM(CASE WHEN s.contract_type = 'call'
                      THEN s.gamma * s.open_interest * 100 * ir.spot_price * ir.spot_price * 0.01
                      ELSE 0 END), 0) AS call_gex,
    COALESCE(SUM(CASE WHEN s.contract_type = 'put'
                      THEN s.gamma * s.open_interest * 100 * ir.spot_price * ir.spot_price * 0.01
                      ELSE 0 END), 0) AS put_gex
  FROM snapshots s
  JOIN ingest_runs ir ON ir.id = s.run_id
  WHERE s.gamma IS NOT NULL
    AND s.open_interest IS NOT NULL
  GROUP BY s.run_id, s.strike
),
ranked AS (
  SELECT
    run_id,
    strike,
    (call_gex - put_gex) AS net_gex,
    ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY (call_gex - put_gex) DESC, strike ASC) AS call_rank,
    ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY (call_gex - put_gex) ASC,  strike ASC) AS put_rank
  FROM strike_gex
),
walls AS (
  SELECT
    run_id,
    MAX(CASE WHEN call_rank = 1 THEN strike END) AS new_call_wall,
    MAX(CASE WHEN put_rank  = 1 THEN strike END) AS new_put_wall
  FROM ranked
  GROUP BY run_id
)
UPDATE computed_levels cl
SET
  call_wall_strike = w.new_call_wall,
  put_wall_strike  = w.new_put_wall
FROM walls w
WHERE cl.run_id = w.run_id
  AND (cl.call_wall_strike IS DISTINCT FROM w.new_call_wall
       OR cl.put_wall_strike  IS DISTINCT FROM w.new_put_wall)
RETURNING cl.run_id, cl.call_wall_strike, cl.put_wall_strike;
