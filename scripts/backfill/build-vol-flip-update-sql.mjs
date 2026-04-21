#!/usr/bin/env node
// Build chunked UPDATE statements for Phase 2 of the vol-flip migration.
// Writes N SQL files under scripts/backfill/state/phase2-sql/, one per
// batch of BATCH_SIZE rows. Each file is a single UPDATE using a
// VALUES-derived table so Postgres can apply all rows in the batch in
// one statement.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const BATCH_SIZE = 500;
const OUT_DIR = 'scripts/backfill/state/phase2-sql';
mkdirSync(OUT_DIR, { recursive: true });

const jsonl = readFileSync('scripts/backfill/state/vol-flip-recompute-results.jsonl', 'utf8')
  .trim().split(/\r?\n/).map(l => JSON.parse(l));

jsonl.sort((a, b) => a.date.localeCompare(b.date));

const batches = [];
for (let i = 0; i < jsonl.length; i += BATCH_SIZE) batches.push(jsonl.slice(i, i + BATCH_SIZE));

for (let b = 0; b < batches.length; b++) {
  const rows = batches[b];
  const values = rows.map(r => `('${r.date}'::date, ${r.flip})`).join(',\n  ');
  const sql = `-- Phase 2 batch ${b + 1}/${batches.length} (${rows.length} rows, ${rows[0].date} → ${rows[rows.length - 1].date})
UPDATE daily_gex_stats
SET vol_flip_strike = v.flip
FROM (VALUES
  ${values}
) AS v(trading_date, flip)
WHERE daily_gex_stats.trading_date = v.trading_date;
`;
  const path = `${OUT_DIR}/batch-${String(b + 1).padStart(2, '0')}.sql`;
  writeFileSync(path, sql);
  console.log(`Wrote ${path} (${rows.length} rows, ${sql.length} bytes)`);
}
console.log(`Total: ${batches.length} batches, ${jsonl.length} rows`);
