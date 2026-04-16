#!/usr/bin/env node
// Reads a JSON file produced by gex-fetch-only.mjs and emits SQL
// INSERT statements suitable for piping into Supabase execute_sql.
// Batches into chunks of 50 rows per INSERT for efficiency.
//
// Usage: node gex-json-to-sql.mjs < input.json

import { readFileSync } from 'node:fs';

const raw = readFileSync(process.argv[2] || '/dev/stdin', 'utf8');
const rows = JSON.parse(raw);
if (!Array.isArray(rows) || rows.length === 0) {
  console.error('No rows to insert');
  process.exit(0);
}

const BATCH = 50;
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  const values = batch
    .map(r => {
      const flip = r.vol_flip_strike != null ? r.vol_flip_strike : 'NULL';
      return `('${r.trading_date}', ${r.spx_close}, ${r.net_gex}, ${r.call_gex}, ${r.put_gex}, ${flip}, ${r.contract_count})`;
    })
    .join(',\n  ');

  console.log(`INSERT INTO daily_gex_stats (trading_date, spx_close, net_gex, call_gex, put_gex, vol_flip_strike, contract_count)
VALUES
  ${values}
ON CONFLICT (trading_date) DO UPDATE SET
  spx_close = EXCLUDED.spx_close, net_gex = EXCLUDED.net_gex,
  call_gex = EXCLUDED.call_gex, put_gex = EXCLUDED.put_gex,
  vol_flip_strike = EXCLUDED.vol_flip_strike, contract_count = EXCLUDED.contract_count,
  computed_at = now();`);
  console.log('---BATCH_SEPARATOR---');
}
console.error(`Generated ${Math.ceil(rows.length / BATCH)} batches for ${rows.length} rows`);
