import type { Handler } from '@netlify/functions';

// Replace this import with the actual module in your repo that already
// computes these values for the React dashboard. The whole point of this
// function is that it reuses the same calculation path so the extension
// and the site can never disagree.
// Example:
//   import { getSnapshot } from '../../src/lib/snapshot';

type Snapshot = {
  asOf: string;
  spot: number;
  putWall: number;
  volFlip: number;
  callWall: number;
  expectedMove: number;
  atmIv: number;
  vrp: number;
  ivRank: number;
  pcRatioVolume: number;
};

// Stub; delete once the real import is wired up.
async function getSnapshot(): Promise<Snapshot> {
  throw new Error('getSnapshot not wired to real data source');
}

const round = (n: number, d: number) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

export const handler: Handler = async () => {
  try {
    const s = await getSnapshot();

    const payload = {
      schemaVersion: 1,
      asOf: s.asOf,
      gammaStatus: s.spot > s.volFlip ? 'POSITIVE' : 'NEGATIVE',
      spot: round(s.spot, 2),
      putWall: round(s.putWall, 2),
      volFlip: round(s.volFlip, 2),
      callWall: round(s.callWall, 2),
      distanceFromRiskOff: round(s.spot - s.volFlip, 2),
      expectedMove: round(s.expectedMove, 2),
      atmIv: round(s.atmIv, 2),
      vrp: round(s.vrp, 2),
      ivRank: round(s.ivRank, 1),
      pcRatioVolume: round(s.pcRatioVolume, 2),
    };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=30, s-maxage=30',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    return {
      statusCode: 503,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({ error: 'unavailable' }),
    };
  }
};
