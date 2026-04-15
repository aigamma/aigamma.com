// Scaffolds for the historical-data hooks. The VRP model needs realized
// vol from an underlying-price series, and a historical-levels chart needs
// the rolling put wall / call wall / vol flip trajectory from daily_levels
// — neither reader endpoint exists yet, so these hooks stand up the shape
// the consumers will use and return inert `{ data: null }` until the
// /api/history/* endpoints land. Keeping the hook surface stable means the
// first model commit that needs one of these flips `data: null` to a real
// fetch in one place instead of redesigning the contract across callers.

export function useHistoricalTermStructure(/* { fromDate, toDate } */) {
  return { data: null, loading: false, error: null };
}

export function useHistoricalCloudBands(/* { fromDate, toDate } */) {
  return { data: null, loading: false, error: null };
}
