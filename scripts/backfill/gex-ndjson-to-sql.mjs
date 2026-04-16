#!/usr/bin/env node
// Reads an NDJSON file (one JSON object per line) produced by
// gex-stream-backfill.mjs and emits SQL INSERT batches.
// Output is suitable for piping into Supabase execute_sql.
//
// Usage: node gex-ndjson-to-sql.mjs < input.ndjson
//   or:  node gex-ndjson-to-sql.mjs path/to/file.ndjson

import { readFileSync } from 'node:fs';

const raw = readFileSync(process.argv[2] || '/dev/stdin', 'utf8');
const rows = raw.split('\n')
  .filter(line => line.trim().length > 0)
  .map(line => JSON.parse(line));

if (rows.length === 0) {
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
