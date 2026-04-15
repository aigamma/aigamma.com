// Thin client around ThetaTerminal v3 REST. Only the endpoints the live
// reconciler needs. All calls are local — http://127.0.0.1:25503. v2
// endpoints return HTTP 410 on the current terminal build; v3 only.
//
// fetchEodGreeks is intentionally a throw stub. ThetaData v3 returns CSV
// for /v3/option/history/greeks/eod and the derivation from that wire
// format into the { levels, termStructure } shape the state machine
// consumes is not implemented yet — the reference CSV client for the
// historical backfill lives in scripts/backfill/theta-eod.mjs but runs
// against SPXW rather than the live reconciler's SPX root, so porting
// it is a real piece of work rather than a one-line change. Tests drive
// the state machine through scripts/reconcile/harness/fake-theta.mjs,
// which bypasses this stub and supplies the derived shape directly.

const DEFAULT_BASE_URL = 'http://127.0.0.1:25503';

export function createThetaClient({ baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch } = {}) {
  async function probe() {
    try {
      const res = await fetchImpl(`${baseUrl}/v3/system/mdds_status`, { method: 'GET' });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function fetchEodGreeks() {
    throw new Error(
      'theta-client.fetchEodGreeks: v3 EOD wire-format parser not implemented. ' +
      'The live reconciler path through scripts/reconcile/run.mjs is not yet wired ' +
      'against real ThetaData responses. Tests run through scripts/reconcile/harness/fake-theta.mjs. ' +
      'A CSV reference for SPXW lives in scripts/backfill/theta-eod.mjs.',
    );
  }

  return { probe, fetchEodGreeks };
}
