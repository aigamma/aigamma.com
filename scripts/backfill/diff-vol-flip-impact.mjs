#!/usr/bin/env node
// Pre-Phase-2 diff: compare pre-migration (strike-axis) flips in the
// backup JSON against newly-computed (gamma-sweep) flips in the JSONL,
// and report how many days' regime labels would flip under the new rule
// spot >= flip ? positive : negative.

import { readFileSync } from 'node:fs';

const backup = JSON.parse(readFileSync('scripts/backfill/state/vol-flip-backup-2026-04-20.json', 'utf8'));
const oldByDate = new Map();
for (const r of backup.rows) oldByDate.set(r.trading_date, r.vol_flip_strike);

const jsonl = readFileSync('scripts/backfill/state/vol-flip-recompute-results.jsonl', 'utf8')
  .trim().split(/\r?\n/).map(l => JSON.parse(l));

let onlyInJsonl = 0, onlyInBackup = 0;
let identical = 0, differBySmall = 0, differBig = 0;
let regimeFlipped = 0, regimeUnchanged = 0;
let oldPositive = 0, newPositive = 0;
const dayFlips = [];

const jsonlDates = new Set(jsonl.map(r => r.date));
for (const d of oldByDate.keys()) if (!jsonlDates.has(d)) onlyInBackup++;

const BIG_THRESHOLD = 50;  // points; arbitrary, flags material repricing
for (const r of jsonl) {
  const oldFlip = oldByDate.get(r.date);
  if (oldFlip == null) { onlyInJsonl++; continue; }
  const delta = Math.abs(r.flip - oldFlip);
  if (delta < 0.5) identical++;
  else if (delta < BIG_THRESHOLD) differBySmall++;
  else differBig++;

  const oldRegime = r.spot >= oldFlip ? 'positive' : 'negative';
  const newRegime = r.spot >= r.flip ? 'positive' : 'negative';
  if (oldRegime === 'positive') oldPositive++;
  if (newRegime === 'positive') newPositive++;
  if (oldRegime !== newRegime) {
    regimeFlipped++;
    dayFlips.push({ date: r.date, spot: r.spot, oldFlip, newFlip: Math.round(r.flip * 100) / 100, oldRegime, newRegime });
  } else regimeUnchanged++;
}

console.log('=== Phase-2 impact diff ===');
console.log(`Total backup rows:   ${backup.rows.length}`);
console.log(`Total JSONL rows:    ${jsonl.length}`);
console.log(`Only in JSONL:       ${onlyInJsonl}`);
console.log(`Only in backup:      ${onlyInBackup}`);
console.log('');
console.log(`Identical (<0.5):    ${identical}`);
console.log(`Small delta (<${BIG_THRESHOLD}):   ${differBySmall}`);
console.log(`Big delta (>=${BIG_THRESHOLD}):   ${differBig}`);
console.log('');
console.log(`Regime unchanged:    ${regimeUnchanged}`);
console.log(`Regime FLIPPED:      ${regimeFlipped}   (${(100 * regimeFlipped / jsonl.length).toFixed(2)}%)`);
console.log('');
console.log(`Days positive (old): ${oldPositive}`);
console.log(`Days positive (new): ${newPositive}`);
console.log('');
if (dayFlips.length > 0) {
  console.log(`First 10 regime-flipped days:`);
  for (const f of dayFlips.slice(0, 10)) {
    console.log(`  ${f.date}  spot=${f.spot.toFixed(2)}  old=${f.oldFlip}→${f.oldRegime.padEnd(8)}  new=${f.newFlip}→${f.newRegime}`);
  }
  console.log(`Last 10 regime-flipped days:`);
  for (const f of dayFlips.slice(-10)) {
    console.log(`  ${f.date}  spot=${f.spot.toFixed(2)}  old=${f.oldFlip}→${f.oldRegime.padEnd(8)}  new=${f.newFlip}→${f.newRegime}`);
  }
}
