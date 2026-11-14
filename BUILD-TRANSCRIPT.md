# BUILD-TRANSCRIPT — Token Launch Radar

Bounty: **"Build the best token launch radar"** (make.fun, $1,325, deadline
Mon 14 Dec 2026 17:00 WIB). Built Sat 2026-11-14 ~18:00 WIB in
`~/workspace/make-fun-entries/token-launch-radar/`.

## Environment

| Item | Value |
| --- | --- |
| VM Node (system, `/usr/bin/node`) | **v24.22.1** (npm 10.9.4) |
| Bounty-required Node | 22.18 |
| Node 22.18.0 binary (downloaded for verification) | `/tmp/node-v22.18.0-linux-x64/bin/node` |
| Dependencies | none (Node built-ins only: `node:http`, global `fetch`) |

**Node version note:** the VM ships Node v24.22.1, not 22.18. The program
targets Node >= 22.18 (type stripping on by default there) and was verified
on both versions (see Tests). `package.json` declares
`"engines": { "node": ">=22.18" }`.

## Commands run & observed output

### 1. Verify DexScreener public API endpoints (curl, live)

```
curl https://api.dexscreener.com/token-profiles/latest/v1
  -> 200, JSON array; first entries are solana pump.fun tokens
     (e.g. SHARK 5uLFMaUwyCny1XLAXYmtbm4zgiazEUVNXKkVXHoPpump)
curl https://api.dexscreener.com/token-boosts/latest/v1
  -> 200
curl https://api.dexscreener.com/token-pairs/v1/solana/5uLFMaUwyCny1XLAXYmtbm4zgiazEUVNXKkVXHoPpump
  -> 200, pair: dexId pumpfun, priceUsd, txns, volume, priceChange, fdv, pairCreatedAt
curl https://api.dexscreener.com/latest/dex/search?q=SOL
  -> 200, {"schemaVersion":"1.0.0","pairs":[...]}
```

All four endpoints used by the program were verified live before coding.
No endpoint was invented; docs at https://docs.dexscreener.com.

### 2. Write the program

- `main.ts` (~700 lines): discovery, enrichment, scoring, CLI table, JSON,
  watch loop, HTTP dashboard, `--selftest` unit tests.
- `package.json`: `{ "type": "module" }`, no dependencies, npm scripts.
- `LICENSE`: MIT, Copyright (c) 2026 Januar.
- `README.md`: usage, scoring formula, data source & scope.

### 3. Tests

#### `--help` + `--selftest` (Node v24.22.1)

```
$ node main.ts --help        -> exit 0, usage text printed
$ node main.ts --selftest
selftest: 8 checks passed
  strong score=90.3 weak score=16.1 (bounds OK)
```

8 deterministic checks, no network: score bounds, weak-token low score,
monotonicity (higher liquidity => higher score), flags (PUMP.FUN / NEW<1H /
PARABOLIC), buy-pressure math, table rendering, arg parsing, log-scale
saturation.

#### Live CLI run (Node v24.22.1)

```
$ time node main.ts --limit 10 --discover 30
TOKEN LAUNCH RADAR — solana — 10 token(s) — 2026-11-14T11:01:22.266Z
  1  73.5 GTA$      ... 28m pumpswap   NEW<1H HOT
  2  70.9 Avatars   ... 1.2h pumpswap  HOT
  3  66.4 FUND      ... 2.8h pumpswap
  ...
  8  58.8 SHARK     ... 10m pumpfun    PUMP.FUN NEW<1H PARABOLIC
 10  57.4 Mymo      ... 47m pumpswap   NEW<1H DUMPING
real 0m3.661s
```

Real live data: 10 ranked tokens, real pump.fun / pumpswap / raydium pairs,
flags firing correctly. Exit 0.

#### Live JSON + search (Node v24.22.1)

```
$ node main.ts --limit 3 --discover 10 --json
  -> valid JSON: generatedAt, chain, source, tokens[] with full breakdown
$ node main.ts --search BONK --limit 3
  -> 2 distinct BONK tokens ranked (deduped by token address; best pair kept)
```

#### Dashboard server (Node v24.22.1)

```
$ node main.ts --serve 8901 --limit 5 --discover 15
Token Launch Radar dashboard: http://localhost:8901/ (API: /api/rankings)
$ curl http://localhost:8901/api/rankings -> 200, live JSON ranking (GTA$ #1, 72.6)
$ curl http://localhost:8901/             -> 200, dashboard HTML
$ curl http://localhost:8901/nope         -> 404
```

Server stopped after the test; port confirmed closed, no stray processes.

#### Strict typecheck (TypeScript 5.9 + @types/node 22, in /tmp)

```
$ tsc --noEmit --strict --skipLibCheck --module nodenext --moduleResolution nodenext --target es2022 main.ts
TSC-STRICT-OK
```

#### Node 22.18.0 verification (downloaded binary)

```
$ curl -o node22.tar.xz https://nodejs.org/dist/v22.18.0/node-v22.18.0-linux-x64.tar.xz
$ /tmp/node-v22.18.0-linux-x64/bin/node --version   -> v22.18.0
$ /tmp/node-v22.18.0-linux-x64/bin/node main.ts --selftest
selftest: 8 checks passed   (type stripping + logic OK on 22.18)
```

**Caveat — live fetch on Node 22.18 inside this VM:** the sandbox routes
egress through an HTTP proxy (`https_proxy=http://...@hatch-egress-proxy:3128`)
that Node only honours via `NODE_USE_ENV_PROXY` (a Node >= 24 feature).
Node 22.18.0 ignores the proxy env vars, so its `fetch()` to external HTTPS
fails here with `SSL routines:ssl3_get_record:wrong version number`. This is
a sandbox-network limitation, not a program bug: on any normal network
(including the make.fun evaluation environment) Node 22.18's `fetch` works
without a proxy. Verified that Node 22.18 `fetch` itself works in this VM
against a local HTTP server (`fetch localhost OK`). All live tests above
therefore ran on the system Node v24.22.1, which honours the proxy.

## How to bundle for make.fun submission (done by parent, not here)

Per the verified submission spec: public GitHub repo created after
14 Nov 2026 07:00 WIB, `main.ts` at repo root, OSI-approved LICENSE, full
commit SHA, and build transcripts uploaded as `.tar.gz` produced by
`node cli/makefun.mjs bundle` (or agent session files).

This folder is self-contained and bundle-ready:

```
token-launch-radar/
  main.ts            # entry point (root, as required)
  package.json       # type: module, no dependencies
  LICENSE            # MIT (OSI-approved)
  README.md
  BUILD-TRANSCRIPT.md  # this file
```

Suggested parent steps:

```bash
# 1. Create a NEW public GitHub repo (after 14 Nov 2026 07:00 WIB) and push:
cd ~/workspace/make-fun-entries/token-launch-radar
git init && git add . && git commit -m "Token Launch Radar — make.fun bounty entry"
git remote add origin <new-public-repo-url> && git push -u origin main
git rev-parse HEAD   # full commit sha for the submission

# 2. Bundle transcripts for the entry:
node cli/makefun.mjs bundle   # from the make.fun CLI checkout; produces the .tar.gz
# (include this BUILD-TRANSCRIPT.md / the agent session files in the bundle)

# 3. Submit on make.fun with the repo URL + full commit sha + bundle.
```

## What was NOT done (out of scope for the builder)

- No GitHub push, no make.fun submission, no payment, no wallet install,
  no live-browser use.
- The starter kit for this bounty was not downloaded (the program was built
  directly against the verified public DexScreener API; no kit content was
  assumed or invented).
- `~/.config/solana/` was never read. No private key or seed was used or
  needed. Reference Solana address (if ever needed by the program):
  `FM6M2TMzjhzj7QztEV91bAwV4N2bApYd2AZpZLcHyeKm`.
