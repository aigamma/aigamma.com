import { useMemo, useState } from 'react';
import './styles/theme.css';
import VolSmile from './components/VolSmile';
import LevelsPanel from './components/LevelsPanel';
import GexProfile from './components/GexProfile';
import TermStructure from './components/TermStructure';
import GexHistory from './components/GexHistory';
import ExposureProfile from './components/ExposureProfile';
import FixedStrikeIvMatrix from './components/FixedStrikeIvMatrix';
import useOptionsData from './hooks/useOptionsData';

function formatFreshness(isoString) {
  if (!isoString) return null;
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return null;
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
  }).format(d);
  return `${et} ET`;
}

export default function App() {
  const [selectedExpiration, setSelectedExpiration] = useState(null);
  const { data, loading, error } = useOptionsData({
    underlying: 'SPY',
    snapshotType: 'intraday',
  });

  const displayExpiration =
    selectedExpiration || (data && data.expirations && data.expirations[0]) || null;

  const filteredContracts = useMemo(() => {
    if (!data || !data.contracts) return [];
    if (!displayExpiration) return data.contracts;
    return data.contracts.filter((c) => c.expiration_date === displayExpiration);
  }, [data, displayExpiration]);

  const freshness = data ? formatFreshness(data.capturedAt) : null;
  const isSynthetic = data && data.source === 'synthetic';

  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '1.5rem' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '0.75rem',
          marginBottom: '1rem',
        }}
      >
        <h1
          style={{
            fontFamily: 'Courier New, monospace',
            fontSize: '1.2rem',
            fontWeight: 400,
            color: 'var(--text-secondary)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          aigamma.dev
        </h1>

        <div
          style={{
            fontFamily: 'Courier New, monospace',
            fontSize: '0.8rem',
            color: 'var(--text-secondary)',
          }}
        >
          {freshness && (
            <>
              <span>AS OF {freshness}</span>
              {isSynthetic && (
                <span
                  style={{
                    marginLeft: '0.5rem',
                    padding: '0.1rem 0.4rem',
                    border: '1px solid var(--accent-amber)',
                    color: 'var(--accent-amber)',
                    borderRadius: '3px',
                  }}
                >
                  SYNTHETIC
                </span>
              )}
            </>
          )}
        </div>
      </header>

      {loading && (
        <div className="card text-muted" style={{ padding: '2rem', textAlign: 'center' }}>
          Loading options data...
        </div>
      )}

      {error && (
        <div className="card" style={{ padding: '2rem', color: 'var(--accent-coral)' }}>
          Error: {error}
        </div>
      )}

      {data && (
        <>
          <LevelsPanel
            levels={data.levels}
            spotPrice={data.spotPrice}
            expirationMetrics={data.expirationMetrics}
            selectedExpiration={displayExpiration}
            capturedAt={data.capturedAt}
          />

          <GexHistory lookback="24h" />

          <GexProfile
            contracts={data.contracts}
            spotPrice={data.spotPrice}
            levels={data.levels}
          />

          <ExposureProfile
            contracts={data.contracts}
            spotPrice={data.spotPrice}
            levels={data.levels}
          />

          <FixedStrikeIvMatrix
            contracts={data.contracts}
            spotPrice={data.spotPrice}
            expirations={data.expirations}
            capturedAt={data.capturedAt}
          />

          <TermStructure
            expirationMetrics={data.expirationMetrics}
            capturedAt={data.capturedAt}
          />

          {data.expirations && data.expirations.length > 1 && (
            <div
              className="card"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                marginBottom: '1rem',
              }}
            >
              <label
                htmlFor="expiration-select"
                style={{
                  fontSize: '0.7rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--text-secondary)',
                }}
              >
                Expiration
              </label>
              <select
                id="expiration-select"
                value={selectedExpiration || data.expirations[0]}
                onChange={(e) => setSelectedExpiration(e.target.value)}
                style={{
                  background: 'var(--bg-primary)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--bg-card-border)',
                  borderRadius: '4px',
                  padding: '0.35rem 0.5rem',
                  fontFamily: 'Courier New, monospace',
                  fontSize: '0.85rem',
                }}
              >
                {data.expirations.map((exp) => (
                  <option key={exp} value={exp}>
                    {exp}
                  </option>
                ))}
              </select>
            </div>
          )}

          <VolSmile
            contracts={filteredContracts}
            spotPrice={data.spotPrice}
            expiration={displayExpiration}
          />
        </>
      )}
    </div>
  );
}
