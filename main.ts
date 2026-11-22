#!/usr/bin/env node
/**
 * Token Launch Radar — make.fun token-radar-01 entry (rebuilt 2026-11-22).
 *
 * The first version of this entry read live token data off the public
 * internet. The grader runs it in a sandbox with no network, so both
 * discovery feeds failed, the program threw, and the run never completed.
 * This version reads only the sealed snapshot the grader mounts and writes
 * everything the gate checks — no network, fully deterministic, so two runs
 * write the same bytes.
 *
 * With no arguments it does the graded run: read /input/snapshot.json, score
 * every pre-token protocol, write the ranked board to /output/board.json and
 * the dashboard's data to /output/data.js, copy dashboard/ and screenshots/
 * to /output, and write /output/dossier.json with the vendored make.fun
 * library (vendor/makefun-board.ts, the kit's own copy, byte for byte).
 *
 * Local runs: MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
 * Selftest:  node main.ts --selftest   (deterministic model checks, no files)
 *
 * Zero dependencies. Node.js >= 22.18 (type stripping on by default).
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODEL,
  ageDays,
  boardIssue,
  buildBoard,
  buildRadar,
  farmSteps,
  impliedValue,
  isPreToken,
  isRankable,
  parseSnapshot,
  stepText,
  type SnapshotProtocol,
} from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The caps the gate enforces on the dossier's text, screenshots and dashboard. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const HELP = `Token Launch Radar — rank pre-token protocols by implied value.

Usage: node main.ts [options]

Options:
  --input <file|dir>   Snapshot to read (default: /input, i.e. /input/snapshot.json)
  --output <dir>       Directory to write (default: $MAKEFUN_OUTPUT_DIR, else /output)
  --selftest           Run deterministic model checks and exit
  --help               Show this help

With no arguments it performs the graded run: snapshot in, board + dashboard
data + screenshots + dossier out. No network is used at any point.
`;

/** Copy one directory's regular files into `to`, skipping dot-names. Returns the names copied. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

function run(): number {
  if (flag('help')) {
    process.stdout.write(HELP);
    return 0;
  }
  if (flag('selftest')) return selftest() ? 0 : 1;

  const inputArg = arg('input', '/input');
  const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
  if (!existsSync(inputFile)) {
    process.stderr.write(
      `token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`,
    );
    return 2;
  }
  const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

  const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
  const { board, radar } = buildRadar(snapshot);
  const issue = boardIssue(board, snapshot);
  if (issue !== null) {
    process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
    return 1;
  }

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
  writeFileSync(join(out, 'data.js'), `window.RADAR=${JSON.stringify(radar)};\n`);

  copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
  const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
  if (shots.length < 3) {
    process.stderr.write(
      `token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`,
    );
    return 1;
  }
  for (const name of shots) {
    if (!IMAGE_NAME.test(name)) {
      process.stderr.write(
        `token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`,
      );
      return 1;
    }
  }

  // The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
  writeFileSync(
    join(out, 'dossier.json'),
    buildDossier(out, {
      text_max_bytes: TEXT_MAX_BYTES,
      screenshots: SCREENSHOT_CAPS,
      dashboard: DASHBOARD_CAPS,
    }),
  );

  process.stdout.write(
    `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
      `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Selftest — deterministic model checks (no network, no files)
// ---------------------------------------------------------------------------

function makeProtocol(overrides: Partial<SnapshotProtocol>): SnapshotProtocol {
  return {
    slug: 'test-protocol',
    name: 'Test Protocol',
    category: 'Lending',
    chains: ['Ethereum'],
    tvl_usd: 100_000_000,
    change_7d: 10,
    mcap_usd: null,
    listed_at: '2024-01-01',
    gecko_id: null,
    symbol: null,
    ...overrides,
  };
}

function check(condition: boolean, message: string, failures: string[]): void {
  if (!condition) failures.push(message);
}

function selftest(): boolean {
  const failures: string[] = [];
  const asOf = '2026-11-14';

  // 1. Implied value follows the formula: base x growth x maturity x breadth.
  const p = makeProtocol({});
  const v = impliedValue(p, asOf, MODEL);
  const age = ageDays(asOf, '2024-01-01')!;
  const expected = Math.max(
    1,
    Math.round(
      100_000_000 * 0.3 * (1 + (10 / 100) * 0.6) * (0.7 + (Math.min(age, 730) / 730) * 0.3) * 1,
    ),
  );
  check(v.implied === expected, `implied value ${v.implied} should be ${expected}`, failures);

  // 2. Monotonicity: more TVL scores higher, all else equal.
  const low = impliedValue(makeProtocol({ tvl_usd: 10_000_000 }), asOf, MODEL).implied;
  const high = impliedValue(makeProtocol({ tvl_usd: 500_000_000 }), asOf, MODEL).implied;
  check(high > low, `higher TVL should score higher (${low} vs ${high})`, failures);

  // 3. Growth helps, contraction hurts; multi-chain adds breadth.
  const up = impliedValue(makeProtocol({ change_7d: 50 }), asOf, MODEL).implied;
  const down = impliedValue(makeProtocol({ change_7d: -40 }), asOf, MODEL).implied;
  check(up > down, `growth should beat contraction (${up} vs ${down})`, failures);
  const wide = impliedValue(makeProtocol({ chains: ['Ethereum', 'Base', 'Arbitrum'] }), asOf, MODEL).implied;
  const narrow = impliedValue(makeProtocol({ chains: ['Ethereum'] }), asOf, MODEL).implied;
  check(wide > narrow, `more chains should score higher (${wide} vs ${narrow})`, failures);

  // 4. Pre-token detection and rankability.
  check(isPreToken(makeProtocol({})), 'a record with no token should be pre-token', failures);
  check(!isPreToken(makeProtocol({ mcap_usd: 1_000_000, symbol: 'TEST' })), 'a record with a token should not be pre-token', failures);
  check(!isRankable(makeProtocol({ category: 'CEX' })), 'an exchange should not be rankable', failures);
  check(!isRankable(makeProtocol({ name: 'Test Protocol V2' })), 'a versioned pool should not be rankable', failures);

  // 5. Farm steps: five steps, each within 20..600 characters.
  const steps = farmSteps(makeProtocol({}), age).map(stepText);
  check(steps.length === 5, `farm plan should have 5 steps, got ${steps.length}`, failures);
  for (const s of steps) check(s.length >= 20 && s.length <= 600, `farm step of ${s.length} chars out of 20..600`, failures);

  // 6. A synthetic snapshot builds a valid board: watchlist covered, ranks 1..N, values ordered.
  const watch: SnapshotProtocol[] = [];
  const protos: SnapshotProtocol[] = [];
  for (let i = 0; i < 120; i++) {
    const proto = makeProtocol({
      slug: `proto-${String(i).padStart(3, '0')}`,
      name: `Protocol ${i}`,
      tvl_usd: 60_000_000 - i * 500_000,
      change_7d: (i % 21) - 10,
    });
    protos.push(proto);
    if (i < 40) watch.push(proto);
  }
  const snap = {
    as_of: asOf,
    source: 'selftest',
    floor_usd: 50_000_000,
    protocols: protos,
    watchlist: watch.map((w) => w.slug),
  };
  const board = buildBoard(snap);
  check(board.length === 120, `synthetic board should hold 120 rows, got ${board.length}`, failures);
  check(boardIssue(board, snap) === null, `synthetic board should pass: ${boardIssue(board, snap)}`, failures);

  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`selftest failed: ${f}\n`);
    return false;
  }
  process.stdout.write('selftest: 6 checks passed\n');
  return true;
}

process.exitCode = run();
