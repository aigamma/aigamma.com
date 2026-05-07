// src/lib/freshness.js
//
// Shared utilities for the quote-freshness and bid/ask-spread indicators
// rolled out across model surfaces in the 2026-05-06 Tier 2 enrichment
// sweep. The pattern was prototyped inline on smile/slots/SlotA.jsx in
// commit a75e9c1 (the multi-model Volatility Smile reading) and then
// extracted here so /local, /rough, /jump, /risk, /discrete, plus the
// /tactical components (TermStructure, RND, FixedStrikeIvMatrix) and
// the homepage Levels Panel can reuse the helpers without inlining the
// same ~25 lines into every slot.
//
// Design constraints (from feedback during the rollout):
//   - Additive only, never math-touching. Helpers compute presentational
//     scalars from per-contract data the snapshot pipeline already lands;
//     they do not modify the IV / Greeks / fit-residual flow that any
//     calibrator reads from.
//   - Fail-open on missing data. Every helper accepts nulls / undefineds
//     anywhere in the input and returns null on degenerate cases rather
//     than NaN, Infinity, or "—" placeholder strings. The visible UI is
//     responsible for hiding clauses when their input returns null.
//   - One sub-line per surface. Each surface picks ONE place to render
//     the freshness/spread context, not a cluster of stat cells. The
//     placement is whatever reads cleanly given the existing layout
//     (chart info line below a picker, sub-line on a stat cell, footer
//     under a chart, etc.).
//
// Two reading directions:
//   freshness — derived from last_trade_ts on each contract, lights up
//     the moment Massive's Options Developer entitlement opens the
//     Trades endpoint (already flowing as of 2026-05-06)
//   spread    — derived from bid_price / ask_price on each contract,
//     stays null until /v3/quotes entitlement propagates; auto-engages
//     when the next snapshot ingest writes non-null bid/ask

// Median across an array of finite numbers; nullish-tolerant input. Returns
// null when the input has no finite values, so callers can chain it through
// formatAge / formatPct without a separate guard. Picks the lower-middle on
// even-length arrays for determinism (two equally-valid medians read
// differently to repeated callers; pick one).
export function median(values) {
  if (!Array.isArray(values)) return null;
  const finite = values.filter((v) => v != null && Number.isFinite(v));
  if (finite.length === 0) return null;
  finite.sort((a, b) => a - b);
  const n = finite.length;
  return n % 2 ? finite[(n - 1) / 2] : 0.5 * (finite[n / 2 - 1] + finite[n / 2]);
}

// Format a millisecond age into the most-readable human unit. Used by every
// "last print N" indicator across the site so the unit choice is consistent:
//   sub-1 minute  -> "Ns"
//   sub-1 hour    -> "Nm"
//   sub-1 day     -> "N.Xh"  (one decimal so a 1.7h reading does not collapse to 2h)
//   1 day or more -> "N.Xd"
// Returns null on null / NaN / negative input so callers can treat missing
// data and bad data the same way.
export function formatAge(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(0)}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(0)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

// Compute the bid/ask spread as a percent of mid for a single contract row.
// Tolerant of missing bid, missing ask, zero bid, ask < bid (degenerate
// quote), and any non-finite values. Returns null on any of those cases.
// The fraction is a fraction, not a percent: 0.0142 = 1.42%; the formatter
// in formatSpreadPct multiplies through and adds the % sign.
export function spreadPctOf(c) {
  if (!c) return null;
  const bid = c.bid_price;
  const ask = c.ask_price;
  if (!(bid > 0) || !(ask > 0) || ask < bid) return null;
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return null;
  return (ask - bid) / mid;
}

// Format a spread fraction (0.0142) as a one-decimal percent string ("1.4%").
// One decimal because a vol trader sizing a position cares about "1.4%" vs
// "2.1%" but not about "1.42%" vs "1.43%"; the extra decimal is wire-noise.
// Returns null on degenerate input so the caller can skip the clause.
export function formatSpreadPct(fraction) {
  if (fraction == null || !Number.isFinite(fraction) || fraction < 0) return null;
  return `${(fraction * 100).toFixed(1)}%`;
}

// Aggregate a list of contracts into the two scalars every surface displays:
// median last-print age (ms since now) and median spread (fraction). Both
// scalars degrade to null when no contract in the list has the underlying
// data populated. The fold is the single point where slots and components
// reduce a chain (or chain slice) to the freshness/spread sub-line, so the
// behavior is consistent across the site.
export function summarizeQuoteContext(contracts, { now = Date.now() } = {}) {
  if (!Array.isArray(contracts) || contracts.length === 0) {
    return { medianAgeMs: null, medianSpread: null };
  }
  const ages = [];
  const spreads = [];
  for (const c of contracts) {
    if (c?.last_trade_ts != null && Number.isFinite(c.last_trade_ts)) {
      const ageMs = now - c.last_trade_ts;
      if (ageMs >= 0) ages.push(ageMs);
    }
    const sp = spreadPctOf(c);
    if (sp != null) spreads.push(sp);
  }
  return {
    medianAgeMs: median(ages),
    medianSpread: median(spreads),
  };
}

// Standalone variant of the freshness/spread clause for surfaces that do
// not have an existing chart-info span to append to. Returns the same
// scalars but without the leading " · " separator and (when the caller
// wants a label) prefixed by a label argument. Returns null when neither
// signal is available so the caller can short-circuit on `if (!clause)
// return null;` and avoid rendering an empty wrapper div.
//
// Usage:
//   const clause = standaloneFreshnessLine(data?.contracts);
//   if (!clause) return null;
//   <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
//     chain inputs · {clause}
//   </div>
//
// (The leading prefix is the caller's responsibility because it differs
// per-surface: "chain inputs", "slice", "per-expiration", etc.)
export function standaloneFreshnessLine(contracts, opts) {
  const { medianAgeMs, medianSpread } = summarizeQuoteContext(contracts, opts);
  const ageStr = formatAge(medianAgeMs);
  const spreadStr = formatSpreadPct(medianSpread);
  const parts = [];
  if (ageStr) parts.push(`last print ${ageStr}`);
  if (spreadStr) parts.push(`spread ${spreadStr}`);
  if (parts.length === 0) return null;
  return parts.join('  ·  ');
}

// Compose a single sub-line clause from the two scalars. Returns:
//   ""                           - both null (nothing to render)
//   " · last print 3m"           - only freshness available
//   " · spread 1.4%"             - only spread available (rare, freshness
//                                  is null only on closed-market days
//                                  where last_trade is also missing)
//   " · last print 3m · spread 1.4%" - both available
//
// The leading " · " separator is the same one used across the site's
// chart info lines so the clause reads as a continuation of whatever
// caller appends it to (e.g., "DTE 7.0 · 24 strikes" + clause). The
// caller is responsible for supplying the leading material; this helper
// only emits the clause portion.
export function freshnessAndSpreadClause(contracts, opts) {
  const { medianAgeMs, medianSpread } = summarizeQuoteContext(contracts, opts);
  const ageStr = formatAge(medianAgeMs);
  const spreadStr = formatSpreadPct(medianSpread);
  const parts = [];
  if (ageStr) parts.push(`last print ${ageStr}`);
  if (spreadStr) parts.push(`spread ${spreadStr}`);
  if (parts.length === 0) return '';
  return ` · ${parts.join('  ·  ')}`;
}
