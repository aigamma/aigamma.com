# ThetaData v3 API Conventions

The Theta Terminal V3 runs locally as a Java process at `http://127.0.0.1:25503/v3`. All queries go through this local REST API. The MCP server is at `http://127.0.0.1:25503/mcp/sse`.

## Parameter conventions (v3 breaking changes from v2)

- Use `symbol` not `root`. The v2 `root` parameter was renamed. Passing `root` returns a 400 with a deprecation message.
- Date format is `YYYYMMDD` (no dashes). Example: `20260410`.
- Response wire format is CSV, not JSON. Parse accordingly.
- Use `symbol=SPXW` for the full PM-settled weeklies chain (covers DTE 0..280+). Bare `SPX` only returns AM-settled monthlies and LEAPS (~20 expirations with gaps).

## Concurrency and rate limits

- Max concurrent requests at Options Standard tier: 2 threads. Do not exceed this.
- Historical depth: back to 2016-01-01. Anything before that requires Pro tier.

## Wildcard queries

- `expiration=*` returns data for every listed option on a symbol for a single date.
- Wildcard queries must be requested day by day, not across date ranges.

## Greeks endpoints

- `rate_type` accepts `sofr` (default) or Treasury tenors (1-month to 30-year). Custom rate via `rate_value`.
- `version=latest` uses real time-to-expiry down to 1-hour minimum for 0DTE. `version=1` uses fixed 0.15 DTE.
- `iv_error` in EOD Greeks is the ratio of BSM-reconstructed price to actual quoted price.

## Available endpoints at Options Standard tier

| Endpoint | Path |
|---|---|
| Options EOD | `option/history/eod` |
| Options Quote | `option/history/quote` |
| Options Open Interest | `option/history/open_interest` |
| Options OHLC | `option/history/ohlc` |
| Options IV | `option/history/greeks/implied_volatility` |
| Options First Order Greeks | `option/history/greeks/first_order` |
| Options EOD Greeks | `option/history/greeks/eod` |
| Index EOD | `index/history/eod` |

## Terminal lifecycle

- Authenticates via FPSS using `creds.txt` in the project root.
- Subscription tier changes require a terminal restart (sometimes multiple due to backend cache).
- The terminal must be running locally for any ThetaData queries to work.
