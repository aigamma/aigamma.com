// Shared number formatters for stat rows and level readouts. Moved out of
// LevelsPanel so future historical-data models render consistent trader-
// friendly values without redeclaring the same helpers per component.

export function formatInteger(value) {
  if (value == null) return '-';
  return Math.round(value).toLocaleString('en-US');
}

export function formatGamma(value) {
  if (value == null) return '-';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toFixed(0);
}

export function formatPercent(value, digits = 2) {
  if (value == null) return '-';
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatRatio(value) {
  if (value == null) return '-';
  return value.toFixed(2);
}
