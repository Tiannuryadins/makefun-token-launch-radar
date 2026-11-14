# Token Launch Radar

Monitor newly launched tokens (Solana / pump.fun / DEX), score and rank them,
and view the results as a CLI table, JSON, a watch loop, or a live web
dashboard. Built for the make.fun bounty **"Build the best token launch
radar"**.

Zero dependencies — one file, `main.ts`, runnable with plain `node`.

## Quick start

Requires Node.js **>= 22.18** (type stripping is on by default there).

```bash
node main.ts                  # rank the newest Solana launches
node main.ts --limit 20       # top 20
node main.ts --json           # JSON output
node main.ts --search BONK    # rank pairs matching a search query
node main.ts --watch 60       # refresh every 60 seconds
node main.ts --serve 8080     # HTML dashboard at http://localhost:8080
                              # (+ JSON API at /api/rankings)
node main.ts --selftest       # deterministic unit tests (no network)
node main.ts --help           # all options
```

No install step, no API key. `npm start` / `npm run dashboard` /
`npm run selftest` also work.

## What it does

1. **Discovers** recently surfaced tokens from two DexScreener public feeds
   (latest token profiles + latest token boosts), filtered to the chosen chain
   (default `solana`), deduplicated.
2. **Enriches** each token with its best pair (highest liquidity, ties broken
   by 24h volume) via the DexScreener token-pairs endpoint.
3. **Scores** each token 0–100 with a transparent, deterministic formula
   (see below), assigns risk/opportunity flags, and ranks them.
4. **Presents** the ranking as a CLI table, JSON, an auto-refreshing watch
   loop, or a self-contained HTML dashboard (built-in `node:http`, no deps).

## Scoring (0–100)

| Component | Weight | How it is computed |
| --- | --- | --- |
| Liquidity | 25 | log scale of pair liquidity, saturates at $1M |
| Volume (24h) | 25 | log scale of 24h volume, saturates at $5M |
| Buy pressure | 15 | share of buys among 24h transactions |
| Momentum | 15 | 1h price change, clamped to −50%…+500% |
| Activity | 10 | log scale of 24h transaction count, saturates at 10k |
| Freshness | 10 | <1h: 10 · <6h: 7 · <24h: 4 · older: 1 |

Flags: `PUMP.FUN` (pump.fun pair), `NEW<1H` (pair younger than 1 hour),
`HOT` (score ≥ 70), `LOW-LIQ` (liquidity < $1k), `SELL-PRESSURE`
(>60% sells), `PARABOLIC` (+300% in 1h), `DUMPING` (−50% in 1h).

## Data source & scope

- **Source:** DexScreener public API — no key required, 300 req/min limit.
  The program stays well under it (5 concurrent enrichment requests).
- **Verified live endpoints** (checked 2026-11-14):
  - `GET https://api.dexscreener.com/token-profiles/latest/v1`
  - `GET https://api.dexscreener.com/token-boosts/latest/v1`
  - `GET https://api.dexscreener.com/token-pairs/v1/{chainId}/{tokenAddress}`
  - `GET https://api.dexscreener.com/latest/dex/search?q={query}`
- **Scope:** any chain DexScreener supports (`--chain base`, `--chain ethereum`,
  …). Default and best-tested: `solana`, where pump.fun launches surface.
- **Coverage notes:**
  - "Newly launched" means "recently surfaced on DexScreener" (profiles/boosts
    feeds) — DexScreener has no public "new pairs" stream, so a token only
    appears once DexScreener lists it. Pair age comes from `pairCreatedAt`.
  - Some pump.fun pairs report no `liquidity.usd`; those score 0 on the
    liquidity component and show `-` in the table (by design, not an error).
  - Data is live market data: prices, volumes and rankings change every run.
- **Not financial advice.** Scores are a heuristic ranking aid, not a buy
  signal. Meme-token launches are extremely risky.

## Example output

```
TOKEN LAUNCH RADAR — solana — 10 token(s) — 2026-11-14T11:01:22Z
  # SCORE SYMBOL            PRICE      MCAP       LIQ   VOL 24H       1H  BUY%    AGE DEX        FLAGS
  1  73.5 GTA$          $0.000166   $166.2K    $36.8K   $157.2K  +212.0%   61%    28m pumpswap   NEW<1H HOT
  2  70.9 Avatars       $0.000136   $130.3K    $27.3K   $598.2K  +136.0%   58%   1.2h pumpswap   HOT
  ...
```

## Files

- `main.ts` — the whole program (CLI + scoring + dashboard server)
- `package.json` — `{ "type": "module" }` + npm scripts (no dependencies)
- `LICENSE` — MIT
- `BUILD-TRANSCRIPT.md` — commands run, observed output, test results,
  Node versions, and how to bundle for make.fun submission
