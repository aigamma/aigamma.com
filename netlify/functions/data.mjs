// netlify/functions/data.mjs
// Thin proxy to Massive API. Replaced by Supabase reads in Phase 4.
// Sets CDN cache headers so Netlify edge absorbs repeat traffic.

const MASSIVE_BASE = 'https://api.massive.com'; 

export default async function handler(request) {
  const url = new URL(request.url);
  const underlying = url.searchParams.get('underlying') || 'SPY';
  const expiration = url.searchParams.get('expiration') || '';
  const apiKey = process.env.MASSIVE_API_KEY;

  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'MASSIVE_API_KEY not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // Fetch all pages of the options chain snapshot
    let allResults = [];
    let nextUrl = buildUrl(underlying, expiration, apiKey);

    while (nextUrl) {
      const res = await fetch(nextUrl);
      if (!res.ok) {
        throw new Error(`Massive API returned ${res.status}`);
      }
      const json = await res.json();
      if (json.results) {
        allResults = allResults.concat(json.results);
      }
      nextUrl = json.next_url ? `${json.next_url}&apiKey=${apiKey}` : null;
    }

    // Extract spot price from the first result that has it
    let spotPrice = null;
    for (const r of allResults) {
      if (r.underlying_asset?.price) {
        spotPrice = r.underlying_asset.price;
        break;
      }
    }

    // Normalize contracts to flat structure for frontend
    const contracts = allResults.map((r) => ({
      strike_price: r.details?.strike_price,
      contract_type: r.details?.contract_type,
      expiration_date: r.details?.expiration_date,
      ticker: r.details?.ticker,
      implied_volatility: r.implied_volatility,
      delta: r.greeks?.delta,
      gamma: r.greeks?.gamma,
      theta: r.greeks?.theta,
      vega: r.greeks?.vega,
      open_interest: r.open_interest,
      volume: r.day?.volume,
      close_price: r.day?.close,
    }));

    // Determine expiration label from data
    const expirations = [...new Set(contracts.map((c) => c.expiration_date).filter(Boolean))];

    const payload = {
      underlying,
      spotPrice,
      expiration: expirations.length === 1 ? expirations[0] : expirations.join(', '),
      contractCount: contracts.length,
      contracts,
    };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=900',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

function buildUrl(underlying, expiration, apiKey) {
  const base = `${MASSIVE_BASE}/v3/snapshot/options/${underlying}?apiKey=${apiKey}&limit=250`;
  if (expiration) {
    return `${base}&expiration_date=${expiration}`;
  }
  // Default: get nearest monthly expiration by not filtering
  // The API returns all expirations; frontend can filter.
  // For now, fetch a specific near-term expiration to keep payload manageable.
  return `${base}&expiration_date.gte=${getNextMonthlyExpiration()}`;
}

function getNextMonthlyExpiration() {
  // Returns the next third-Friday monthly expiration in YYYY-MM-DD format
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth(); // 0-indexed

  for (let i = 0; i < 3; i++) {
    const candidate = getThirdFriday(year, month + i);
    if (candidate > now) {
      return candidate.toISOString().split('T')[0];
    }
  }
  // Fallback: 30 days out
  const fallback = new Date(now.getTime() + 30 * 86400000);
  return fallback.toISOString().split('T')[0];
}

function getThirdFriday(year, month) {
  // month is 0-indexed
  if (month > 11) {
    year += Math.floor(month / 12);
    month = month % 12;
  }
  const first = new Date(year, month, 1);
  // Day of week: 0=Sun, 5=Fri
  let firstFriday = 1 + ((5 - first.getDay() + 7) % 7);
  let thirdFriday = firstFriday + 14;
  return new Date(year, month, thirdFriday);
}
