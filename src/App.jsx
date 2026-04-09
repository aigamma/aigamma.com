import './styles/theme.css';
import VolSmile from './components/VolSmile';
import useOptionsData from './hooks/useOptionsData';

export default function App() {
  const { data, loading, error } = useOptionsData('SPY');

  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '1.5rem' }}>
      <header style={{ marginBottom: '1rem' }}>
        <h1 style={{ fontFamily: 'Courier New, monospace', fontSize: '1.2rem', fontWeight: 400, color: '#8a8f9c', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          aigamma.dev
        </h1>
      </header>

      {loading && (
        <div className="card text-muted" style={{ padding: '2rem', textAlign: 'center' }}>
          Loading options data...
        </div>
      )}

      {error && (
        <div className="card" style={{ padding: '2rem', color: '#d85a30' }}>
          Error: {error}
        </div>
      )}

      {data && (
        <VolSmile
          contracts={data.contracts}
          spotPrice={data.spotPrice}
          expiration={data.expiration}
        />
      )}
    </div>
  );
}
