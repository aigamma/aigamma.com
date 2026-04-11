function formatCurrency(value) {
  if (value == null) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatStrike(value) {
  if (value == null) return '—';
  return value.toFixed(2);
}

function formatGamma(value) {
  if (value == null) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toFixed(0);
}

function formatPercent(value, digits = 2) {
  if (value == null) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

function formatTilt(value) {
  if (value == null) return '—';
  return value.toFixed(3);
}

function Stat({ label, value, accent }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: '0.7rem',
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          marginBottom: '0.25rem',
        }}
      >
        {label}
      </div>
      <div
        className="data-value"
        style={{
          fontSize: '1.05rem',
          color: accent || 'var(--text-primary)',
        }}
      >
        {value}
      </div>
    </div>
  );
}

export default function LevelsPanel({ levels, spotPrice, expirationMetrics, selectedExpiration }) {
  if (!levels) {
    return (
      <div className="card text-muted" style={{ marginBottom: '1rem' }}>
        No computed levels available for this run.
      </div>
    );
  }

  const netGammaColor =
    levels.net_gamma_notional == null
      ? undefined
      : levels.net_gamma_notional >= 0
        ? 'var(--accent-green)'
        : 'var(--accent-coral)';

  const zeroGammaColor =
    levels.zero_gamma_level != null && spotPrice != null
      ? spotPrice >= levels.zero_gamma_level
        ? 'var(--accent-green)'
        : 'var(--accent-coral)'
      : undefined;

  const relevantMetric =
    expirationMetrics && expirationMetrics.length > 0
      ? expirationMetrics.find((m) => m.expiration_date === selectedExpiration) || expirationMetrics[0]
      : null;

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
          gap: '1rem',
          marginBottom: relevantMetric ? '1rem' : 0,
        }}
      >
        <Stat label="Spot" value={formatCurrency(spotPrice)} accent="var(--accent-blue)" />
        <Stat label="Call Wall" value={formatStrike(levels.call_wall)} accent="var(--accent-green)" />
        <Stat label="Put Wall" value={formatStrike(levels.put_wall)} accent="var(--accent-coral)" />
        <Stat label="Abs Gamma" value={formatStrike(levels.abs_gamma_strike)} accent="var(--accent-amber)" />
        <Stat label="Zero Gamma" value={formatStrike(levels.zero_gamma_level)} accent={zeroGammaColor} />
        <Stat label="Net GEX ($)" value={formatGamma(levels.net_gamma_notional)} accent={netGammaColor} />
        <Stat label="Gamma Tilt" value={formatTilt(levels.gamma_tilt)} />
      </div>

      {relevantMetric && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
            gap: '1rem',
            paddingTop: '1rem',
            borderTop: '1px solid var(--bg-card-border)',
          }}
        >
          <Stat
            label={`ATM IV (${relevantMetric.expiration_date})`}
            value={formatPercent(relevantMetric.atm_iv)}
          />
          <Stat label="ATM Strike" value={formatStrike(relevantMetric.atm_strike)} />
          <Stat label="25Δ Put IV" value={formatPercent(relevantMetric.put_25d_iv)} />
          <Stat label="25Δ Call IV" value={formatPercent(relevantMetric.call_25d_iv)} />
          <Stat
            label="25Δ Risk Reversal"
            value={formatPercent(relevantMetric.skew_25d_rr, 3)}
            accent={
              relevantMetric.skew_25d_rr == null
                ? undefined
                : relevantMetric.skew_25d_rr >= 0
                  ? 'var(--accent-green)'
                  : 'var(--accent-coral)'
            }
          />
        </div>
      )}
    </div>
  );
}
