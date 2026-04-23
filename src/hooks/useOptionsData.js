import { useState, useEffect } from 'react';

export default function useOptionsData({ underlying = 'SPX', snapshotType = 'intraday', expiration = null, tradingDate = null, prevDay = false, enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    async function fetchData() {
      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({ underlying, snapshot_type: snapshotType });
        if (expiration) params.set('expiration', expiration);
        if (tradingDate) params.set('date', tradingDate);
        if (prevDay && !tradingDate) params.set('prev_day', '1');

        const response = await fetch(`/api/data?${params}`);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`API ${response.status}: ${text}`);
        }

        const json = await response.json();
        if (!cancelled) {
          setData(json);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchData();
    return () => {
      cancelled = true;
    };
  }, [underlying, snapshotType, expiration, tradingDate, prevDay, retryCount, enabled]);

  return { data, loading: enabled && loading, error, refetch: () => setRetryCount((c) => c + 1) };
}
