# Token Launch Radar

**make.fun bounty: "Build the best token launch radar"** — a program plus the
web dashboard it writes. It reads a sealed snapshot of every protocol
DefiLlama tracks, works out which ones still record no token, ranks them by
what their launch would be worth, and hands in a dashboard that shows the
board, a detail view for each protocol, and the steps to farm it.

## The model (radar-2)

Implied value follows only from the snapshot's own figures — TVL, seven-day
growth, age with no token, and chain breadth. No name is ever special-cased.

```
implied = TVL x 0.30 x (1 + growth% x 0.60) x maturity x breadth
  growth   = clamp(change_7d, -50, 150) per cent
  maturity = 0.70 + min(age_days, 730) / 730 x 0.30   (age unknown: 180 days)
  breadth  = 1 + 0.03 x min(chains - 1, 4)
```

A protocol is pre-token when its record carries no token at all: no market
cap, no CoinGecko id, no symbol. The board covers every slug on the
snapshot's watchlist (40) and adds the strongest pre-token protocols below
the watchlist floor, chosen by the model itself — by implied value, not by
raw TVL. This snapshot's board holds **226 rows** (40 watchlist + 186 early).
Protocols whose token already trades are kept apart and shown with the
market's own values, never mixed into the ranked board.

Each row carries a five-step farm plan derived from the protocol's own
record (category, chains, TVL, age), each step naming its cost and time.

## Usage

```bash
# Graded run (what the grader does): snapshot in, board + dashboard + dossier out
node main.ts

# Local run against the kit's snapshot
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>

# Deterministic model checks (no network, no files)
node main.ts --selftest
```

With no arguments the program reads `/input/snapshot.json` and writes to
`/output`: `board.json` (the ranked board), `data.js` (the dashboard's
dataset), `dashboard/` and `screenshots/` (copied from this repository), and
`dossier.json` (built with the vendored make.fun library). It uses no
network at any point and is fully deterministic — two runs write the same
bytes.

## The dashboard

A static page, no framework and no network: `dashboard/index.html`,
`dashboard/app.css`, `dashboard/app.js`. It renders the board from `data.js`
with search, category and chain filters, a watchlist toggle, sortable
columns, a detail view for every protocol (model breakdown + farm plan), a
model panel that re-ranks the board live under your own constants, and a
market view of the protocols already trading.

The three screenshots under `screenshots/` show the board, a protocol's
detail view and a filtered view. They were rendered from the dashboard's own
data with PIL (no browser is available on the build machine), in the
dashboard's own design and with its own values.

## Layout

```
main.ts                  Entry point: snapshot in, board + dashboard + dossier out
lib/model.ts             The value model, farm plans, board validation, data.js
vendor/makefun-board.ts  make.fun's dossier library (the kit's copy, byte for byte)
dashboard/               The static page (index.html, app.css, app.js)
screenshots/             Board, detail and filtered views (1440x900 PNG)
LICENSE                  MIT
BUILD-TRANSCRIPT.md      Build + repair record
```

## Data

The snapshot is the sealed DefiLlama protocol data the competition mounts at
`/input/snapshot.json` (758 protocols at or above $5,000,000 of TVL, 40 on
the watchlist, fetched 2026-11-14). The program reads it and nothing else.
A protocol is listed as pre-token when its record carries no token — the
record is not proof, and implied values are this radar's own claim, never a
promise.
