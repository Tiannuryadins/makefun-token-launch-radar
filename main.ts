#!/usr/bin/env node
/**
 * Token Launch Radar — make.fun bounty entry
 * "Build the best token launch radar"
 *
 * Monitors newly launched tokens (Solana / pump.fun / DEX), scores and ranks
 * them, and presents the results as a CLI table, JSON, a watch loop, or a
 * small self-contained web dashboard.
 *
 * Data source: DexScreener public API (no API key required).
 * Verified live endpoints (2026-11-14):
 *   GET https://api.dexscreener.com/token-profiles/latest/v1
 *   GET https://api.dexscreener.com/token-boosts/latest/v1
 *   GET https://api.dexscreener.com/token-pairs/v1/{chainId}/{tokenAddress}
 *   GET https://api.dexscreener.com/latest/dex/search?q={query}
 *
 * Docs: https://docs.dexscreener.com (public API, 300 req/min rate limit).
 *
 * Zero dependencies. Runs on Node.js >= 22.18 (type stripping enabled by
 * default) with plain `node main.ts`. Uses only erasable TypeScript syntax
 * (interfaces + type annotations), so no build step is needed.
 *
 * Usage:
 *   node main.ts                          Rank newest Solana launches (CLI table)
 *   node main.ts --limit 20               Show top 20
 *   node main.ts --json                   Emit JSON instead of a table
 *   node main.ts --search BONK            Search + rank matching pairs
 *   node main.ts --watch 60               Refresh the ranking every 60s
 *   node main.ts --serve 8080             Serve a live HTML dashboard
 *   node main.ts --min-liquidity 5000     Only tokens with >= $5k liquidity
 *   node main.ts --chain base             Use another chain (solana default)
 *   node main.ts --selftest               Run deterministic unit tests
 *   node main.ts --help                   Show help
 */

import http from "node:http";

// ---------------------------------------------------------------------------
// Types (DexScreener API shapes, trimmed to the fields we use)
// ---------------------------------------------------------------------------

interface TokenProfile {
  chainId: string;
  tokenAddress: string;
  url?: string;
  description?: string;
  links?: Array<{ type?: string; label?: string; url?: string }>;
}

interface TokenBoost {
  chainId: string;
  tokenAddress: string;
  amount?: number;
  totalAmount?: number;
}

interface DexPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: {
    m5?: { buys: number; sells: number };
    h1?: { buys: number; sells: number };
    h6?: { buys: number; sells: number };
    h24?: { buys: number; sells: number };
  };
  volume?: { h24?: number; h6?: number; h1?: number; m5?: number };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

interface SearchResponse {
  schemaVersion: string;
  pairs: DexPair[] | null;
}

interface RankedToken {
  rank: number;
  score: number;
  address: string;
  chain: string;
  name: string;
  symbol: string;
  dex: string;
  pairAddress: string;
  url: string;
  priceUsd: number | null;
  marketCap: number | null;
  liquidityUsd: number | null;
  volumeH24: number | null;
  volumeH1: number | null;
  changeH1: number | null;
  changeH24: number | null;
  buysH24: number;
  sellsH24: number;
  buyPressure: number | null; // 0..1, fraction of buys among h24 txns
  ageMinutes: number | null;
  flags: string[];
  breakdown: ScoreBreakdown;
}

interface ScoreBreakdown {
  liquidity: number; // 0..25
  volume: number; // 0..25
  buyPressure: number; // 0..15
  momentum: number; // 0..15
  activity: number; // 0..10
  freshness: number; // 0..10
}

interface RadarOptions {
  chain: string;
  limit: number;
  minLiquidity: number;
  json: boolean;
  search: string | null;
  watchSeconds: number;
  servePort: number;
  discover: number; // how many candidate tokens to pull from discovery feeds
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = "https://api.dexscreener.com";
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_RETRIES = 2;
const ENRICH_CONCURRENCY = 5; // stay well under the 300 req/min public limit
const USER_AGENT = "token-launch-radar/1.0 (make.fun bounty entry)";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Log-scale 0..1 score: value -> 1 when it reaches `cap`. */
function logScale(value: number, cap: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return clamp(Math.log10(value + 1) / Math.log10(cap + 1), 0, 1);
}

async function fetchJson<T>(url: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "application/json", "user-agent": USER_AGENT },
      });
      if (res.status === 429) {
        // Rate limited: back off longer before retrying.
        await sleep(5_000 * (attempt + 1));
        lastError = new Error(`HTTP 429 rate limited: ${url}`);
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastError = err;
      if (attempt < FETCH_RETRIES) await sleep(1_000 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/** Run async tasks with bounded concurrency, preserving order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Discovery — find recently launched tokens
// ---------------------------------------------------------------------------

async function discoverTokenAddresses(
  chain: string,
  count: number,
): Promise<string[]> {
  // Two independent "recently surfaced" feeds, merged + deduped. Both are
  // public DexScreener endpoints returning the newest entries first.
  const [profiles, boosts] = await Promise.all([
    fetchJson<TokenProfile[]>(`${API_BASE}/token-profiles/latest/v1`).catch(
      (err: unknown) => {
        console.error(`warn: token-profiles feed failed: ${String(err)}`);
        return [] as TokenProfile[];
      },
    ),
    fetchJson<TokenBoost[]>(`${API_BASE}/token-boosts/latest/v1`).catch(
      (err: unknown) => {
        console.error(`warn: token-boosts feed failed: ${String(err)}`);
        return [] as TokenBoost[];
      },
    ),
  ]);

  const seen = new Set<string>();
  const addresses: string[] = [];
  for (const entry of [...profiles, ...boosts]) {
    if (entry.chainId !== chain) continue;
    if (!entry.tokenAddress || seen.has(entry.tokenAddress)) continue;
    seen.add(entry.tokenAddress);
    addresses.push(entry.tokenAddress);
    if (addresses.length >= count) break;
  }
  return addresses;
}

// ---------------------------------------------------------------------------
// Enrichment — pair data per token
// ---------------------------------------------------------------------------

async function fetchBestPair(
  chain: string,
  tokenAddress: string,
): Promise<DexPair | null> {
  const pairs = await fetchJson<DexPair[]>(
    `${API_BASE}/token-pairs/v1/${chain}/${tokenAddress}`,
  ).catch((err: unknown) => {
    console.error(`warn: pairs for ${tokenAddress} failed: ${String(err)}`);
    return [] as DexPair[];
  });
  if (!pairs || pairs.length === 0) return null;
  // Best pair = highest liquidity; ties broken by h24 volume.
  return pairs.reduce((best, pair) => {
    const liq = pair.liquidity?.usd ?? 0;
    const bestLiq = best.liquidity?.usd ?? 0;
    if (liq !== bestLiq) return liq > bestLiq ? pair : best;
    return (pair.volume?.h24 ?? 0) > (best.volume?.h24 ?? 0) ? pair : best;
  });
}

async function searchPairs(query: string): Promise<DexPair[]> {
  const res = await fetchJson<SearchResponse>(
    `${API_BASE}/latest/dex/search?q=${encodeURIComponent(query)}`,
  );
  return res.pairs ?? [];
}

// ---------------------------------------------------------------------------
// Scoring — transparent, deterministic, documented in README
// ---------------------------------------------------------------------------

function scorePair(pair: DexPair, nowMs: number): ScoreBreakdown {
  const liquidity = pair.liquidity?.usd ?? 0;
  const volumeH24 = pair.volume?.h24 ?? 0;
  const buys = pair.txns?.h24?.buys ?? 0;
  const sells = pair.txns?.h24?.sells ?? 0;
  const txnsH24 = buys + sells;
  const changeH1 = pair.priceChange?.h1 ?? 0;
  const ageMinutes =
    pair.pairCreatedAt != null ? (nowMs - pair.pairCreatedAt) / 60_000 : null;

  // Liquidity: log scale, saturates at $1M. Weight 25.
  const liquidityScore = logScale(liquidity, 1_000_000) * 25;

  // Volume (h24): log scale, saturates at $5M. Weight 25.
  const volumeScore = logScale(volumeH24, 5_000_000) * 25;

  // Buy pressure: share of buys among h24 txns. 50/50 -> 7.5, all buys -> 15.
  const buyShare = txnsH24 > 0 ? buys / txnsH24 : 0.5;
  const buyPressureScore = buyShare * 15;

  // Momentum: h1 change clamped to [-50%, +500%], mapped to 0..15.
  const momentumScore =
    clamp((changeH1 + 50) / 550, 0, 1) * 15;

  // Activity: h24 txn count, log scale, saturates at 10k txns. Weight 10.
  const activityScore = logScale(txnsH24, 10_000) * 10;

  // Freshness: newest launches get the most. Weight 10.
  let freshnessScore = 1;
  if (ageMinutes != null) {
    if (ageMinutes < 60) freshnessScore = 10;
    else if (ageMinutes < 360) freshnessScore = 7;
    else if (ageMinutes < 1440) freshnessScore = 4;
    else freshnessScore = 1;
  }

  return {
    liquidity: round1(liquidityScore),
    volume: round1(volumeScore),
    buyPressure: round1(buyPressureScore),
    momentum: round1(momentumScore),
    activity: round1(activityScore),
    freshness: freshnessScore,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function totalScore(b: ScoreBreakdown): number {
  return round1(
    b.liquidity + b.volume + b.buyPressure + b.momentum + b.activity + b.freshness,
  );
}

function flagPair(pair: DexPair, score: number, nowMs: number): string[] {
  const flags: string[] = [];
  const liquidity = pair.liquidity?.usd ?? 0;
  const buys = pair.txns?.h24?.buys ?? 0;
  const sells = pair.txns?.h24?.sells ?? 0;
  const txnsH24 = buys + sells;
  const changeH1 = pair.priceChange?.h1 ?? 0;
  const ageMinutes =
    pair.pairCreatedAt != null ? (nowMs - pair.pairCreatedAt) / 60_000 : null;

  if (pair.dexId === "pumpfun") flags.push("PUMP.FUN");
  if (ageMinutes != null && ageMinutes < 60) flags.push("NEW<1H");
  if (score >= 70) flags.push("HOT");
  if (liquidity > 0 && liquidity < 1_000) flags.push("LOW-LIQ");
  if (txnsH24 >= 20 && sells / txnsH24 > 0.6) flags.push("SELL-PRESSURE");
  if (changeH1 > 300) flags.push("PARABOLIC");
  if (changeH1 < -50) flags.push("DUMPING");
  return flags;
}

function rankPair(pair: DexPair, nowMs: number): RankedToken {
  const breakdown = scorePair(pair, nowMs);
  const score = totalScore(breakdown);
  const buys = pair.txns?.h24?.buys ?? 0;
  const sells = pair.txns?.h24?.sells ?? 0;
  const txnsH24 = buys + sells;
  return {
    rank: 0, // assigned after sorting
    score,
    address: pair.baseToken.address,
    chain: pair.chainId,
    name: pair.baseToken.name,
    symbol: pair.baseToken.symbol,
    dex: pair.dexId,
    pairAddress: pair.pairAddress,
    url: pair.url,
    priceUsd: pair.priceUsd != null ? Number(pair.priceUsd) : null,
    marketCap: pair.marketCap ?? null,
    liquidityUsd: pair.liquidity?.usd ?? null,
    volumeH24: pair.volume?.h24 ?? null,
    volumeH1: pair.volume?.h1 ?? null,
    changeH1: pair.priceChange?.h1 ?? null,
    changeH24: pair.priceChange?.h24 ?? null,
    buysH24: buys,
    sellsH24: sells,
    buyPressure: txnsH24 > 0 ? round1((buys / txnsH24) * 100) / 100 : null,
    ageMinutes:
      pair.pairCreatedAt != null
        ? Math.max(0, Math.round((nowMs - pair.pairCreatedAt) / 60_000))
        : null,
    flags: flagPair(pair, score, nowMs),
    breakdown,
  };
}

// ---------------------------------------------------------------------------
// Ranking pipeline
// ---------------------------------------------------------------------------

async function buildRanking(opts: RadarOptions): Promise<RankedToken[]> {
  const nowMs = Date.now();
  let pairs: DexPair[];

  if (opts.search) {
    const found = await searchPairs(opts.search);
    const byToken = new Map<string, DexPair>();
    for (const pair of found) {
      if (pair.chainId !== opts.chain) continue;
      const prev = byToken.get(pair.baseToken.address);
      if (!prev || (pair.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) {
        byToken.set(pair.baseToken.address, pair);
      }
    }
    pairs = [...byToken.values()];
    if (pairs.length === 0) {
      console.error(
        `No pairs found for "${opts.search}" on chain "${opts.chain}".`,
      );
    }
  } else {
    const addresses = await discoverTokenAddresses(opts.chain, opts.discover);
    if (addresses.length === 0) {
      throw new Error(
        "Discovery feeds returned no tokens. Check network access to api.dexscreener.com.",
      );
    }
    const enriched = await mapLimit(addresses, ENRICH_CONCURRENCY, (addr) =>
      fetchBestPair(opts.chain, addr),
    );
    pairs = enriched.filter((p): p is DexPair => p !== null);
  }

  const ranked = pairs
    .map((pair) => rankPair(pair, nowMs))
    .filter((t) => (t.liquidityUsd ?? 0) >= opts.minLiquidity)
    .sort((a, b) => b.score - a.score || (b.volumeH24 ?? 0) - (a.volumeH24 ?? 0))
    .slice(0, opts.limit);

  ranked.forEach((t, i) => {
    t.rank = i + 1;
  });
  return ranked;
}

// ---------------------------------------------------------------------------
// Rendering — CLI table
// ---------------------------------------------------------------------------

function fmtUsd(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "-";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toPrecision(2)}`;
  return "$0";
}

function fmtPrice(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "-";
  if (n >= 1) return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toExponential(2)}`;
}

function fmtPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "-";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function fmtAge(minutes: number | null): string {
  if (minutes == null) return "-";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}

function pad(s: string, width: number, align: "left" | "right" = "left"): string {
  if (s.length >= width) return s.slice(0, width);
  const fill = " ".repeat(width - s.length);
  return align === "right" ? fill + s : s + fill;
}

function renderTable(ranked: RankedToken[], opts: RadarOptions): string {
  const lines: string[] = [];
  const stamp = new Date().toISOString();
  lines.push(
    `TOKEN LAUNCH RADAR — ${opts.chain} — ${ranked.length} token(s) — ${stamp}`,
  );
  lines.push(
    `Score = liquidity(25) + volume(25) + buy pressure(15) + momentum(15) + activity(10) + freshness(10). Source: DexScreener public API.`,
  );
  lines.push("");
  const header =
    pad("#", 3, "right") +
    " " +
    pad("SCORE", 5, "right") +
    " " +
    pad("SYMBOL", 10) +
    " " +
    pad("PRICE", 12, "right") +
    " " +
    pad("MCAP", 9, "right") +
    " " +
    pad("LIQ", 9, "right") +
    " " +
    pad("VOL 24H", 9, "right") +
    " " +
    pad("1H", 8, "right") +
    " " +
    pad("BUY%", 5, "right") +
    " " +
    pad("AGE", 6, "right") +
    " " +
    pad("DEX", 9) +
    "  FLAGS";
  lines.push(header);
  lines.push("-".repeat(header.length));
  for (const t of ranked) {
    lines.push(
      pad(String(t.rank), 3, "right") +
        " " +
        pad(t.score.toFixed(1), 5, "right") +
        " " +
        pad(t.symbol, 10) +
        " " +
        pad(fmtPrice(t.priceUsd), 12, "right") +
        " " +
        pad(fmtUsd(t.marketCap), 9, "right") +
        " " +
        pad(fmtUsd(t.liquidityUsd), 9, "right") +
        " " +
        pad(fmtUsd(t.volumeH24), 9, "right") +
        " " +
        pad(fmtPct(t.changeH1), 8, "right") +
        " " +
        pad(
          t.buyPressure != null ? `${Math.round(t.buyPressure * 100)}%` : "-",
          5,
          "right",
        ) +
        " " +
        pad(fmtAge(t.ageMinutes), 6, "right") +
        " " +
        pad(t.dex, 9) +
        "  " +
        t.flags.join(" "),
    );
  }
  lines.push("");
  lines.push("Top token links:");
  for (const t of ranked.slice(0, 5)) {
    lines.push(`  #${t.rank} ${t.symbol} (${t.address}) -> ${t.url}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Dashboard — tiny zero-dependency HTTP server
// ---------------------------------------------------------------------------

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Token Launch Radar</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3; margin: 0; padding: 24px; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  p.sub { color: #8b949e; margin: 0 0 16px; font-size: 0.9rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
  th, td { border-bottom: 1px solid #30363d; padding: 8px 10px; text-align: right; white-space: nowrap; }
  th:first-child, td:first-child, th:nth-child(3), td:nth-child(3) { text-align: left; }
  th { color: #8b949e; font-weight: 600; }
  .up { color: #3fb950; } .down { color: #f85149; }
  .flag { display: inline-block; background: #21262d; border: 1px solid #30363d; border-radius: 10px; padding: 1px 8px; margin-right: 4px; font-size: 0.75rem; }
  .flag.hot { background: #3d1d00; border-color: #9e6a03; color: #f0a13c; }
  a { color: #58a6ff; text-decoration: none; }
  #status { color: #8b949e; font-size: 0.85rem; margin-bottom: 12px; }
</style>
</head>
<body>
<h1>&#128225; Token Launch Radar</h1>
<p class="sub">New token launches ranked by liquidity, volume, buy pressure, momentum, activity &amp; freshness. Source: DexScreener public API. Auto-refreshes every 60s.</p>
<div id="status">Loading…</div>
<table>
<thead><tr><th>#</th><th>Score</th><th>Token</th><th>Price</th><th>MCap</th><th>Liquidity</th><th>Vol 24h</th><th>1h</th><th>Buy %</th><th>Age</th><th>DEX</th><th>Flags</th></tr></thead>
<tbody id="rows"></tbody>
</table>
<script>
async function refresh() {
  try {
    const res = await fetch('/api/rankings');
    const data = await res.json();
    document.getElementById('status').textContent =
      'Chain: ' + data.chain + ' · ' + data.tokens.length + ' tokens · updated ' + new Date(data.generatedAt).toLocaleTimeString();
    const rows = data.tokens.map(t => {
      const chg = t.changeH1 == null ? '-' : (t.changeH1 > 0 ? '+' : '') + t.changeH1.toFixed(1) + '%';
      const cls = t.changeH1 == null ? '' : (t.changeH1 >= 0 ? 'up' : 'down');
      const usd = v => v == null ? '-' : v >= 1e6 ? '$' + (v/1e6).toFixed(2) + 'M' : v >= 1e3 ? '$' + (v/1e3).toFixed(1) + 'K' : '$' + v.toFixed(2);
      const age = t.ageMinutes == null ? '-' : t.ageMinutes < 60 ? t.ageMinutes + 'm' : t.ageMinutes < 1440 ? (t.ageMinutes/60).toFixed(1) + 'h' : (t.ageMinutes/1440).toFixed(1) + 'd';
      const flags = t.flags.map(f => '<span class="flag' + (f === 'HOT' ? ' hot' : '') + '">' + f + '</span>').join('');
      return '<tr><td>' + t.rank + '</td><td><b>' + t.score.toFixed(1) + '</b></td>' +
        '<td><a href="' + t.url + '" target="_blank" rel="noopener">' + t.symbol + '</a> <span style="color:#8b949e">' + t.name + '</span></td>' +
        '<td>' + (t.priceUsd == null ? '-' : '$' + t.priceUsd.toPrecision(4)) + '</td>' +
        '<td>' + usd(t.marketCap) + '</td><td>' + usd(t.liquidityUsd) + '</td><td>' + usd(t.volumeH24) + '</td>' +
        '<td class="' + cls + '">' + chg + '</td>' +
        '<td>' + (t.buyPressure == null ? '-' : Math.round(t.buyPressure * 100) + '%') + '</td>' +
        '<td>' + age + '</td><td>' + t.dex + '</td><td>' + flags + '</td></tr>';
    }).join('');
    document.getElementById('rows').innerHTML = rows || '<tr><td colspan="12">No tokens found.</td></tr>';
  } catch (e) {
    document.getElementById('status').textContent = 'Failed to load rankings: ' + e;
  }
}
refresh();
setInterval(refresh, 60000);
</script>
</body>
</html>
`;

async function serveDashboard(opts: RadarOptions): Promise<void> {
  let cache: { at: number; tokens: RankedToken[] } | null = null;
  const CACHE_MS = 30_000;

  async function getRankings(): Promise<RankedToken[]> {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.tokens;
    const tokens = await buildRanking(opts);
    cache = { at: Date.now(), tokens };
    return tokens;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(DASHBOARD_HTML);
      return;
    }
    if (url.pathname === "/api/rankings") {
      getRankings()
        .then((tokens) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              generatedAt: new Date().toISOString(),
              chain: opts.chain,
              source: "DexScreener public API",
              tokens,
            }),
          );
        })
        .catch((err: unknown) => {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  await new Promise<void>((resolve) => {
    server.listen(opts.servePort, () => {
      console.log(
        `Token Launch Radar dashboard: http://localhost:${opts.servePort}/ (API: /api/rankings)`,
      );
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const HELP = `Token Launch Radar — rank newly launched tokens (Solana / pump.fun / DEX).

Usage: node main.ts [options]

Options:
  --chain <id>            Chain to scan (default: solana)
  --limit <n>             Tokens to show (default: 15)
  --discover <n>          Candidates pulled from discovery feeds (default: 40)
  --min-liquidity <usd>   Minimum pair liquidity in USD (default: 0)
  --search <query>        Rank pairs matching a DexScreener search instead
  --json                  Emit JSON instead of the CLI table
  --watch <seconds>       Re-rank every N seconds until Ctrl+C
  --serve <port>          Serve the HTML dashboard + /api/rankings JSON
  --selftest              Run deterministic unit tests and exit
  --help                  Show this help

Examples:
  node main.ts --limit 20
  node main.ts --search BONK --json
  node main.ts --watch 60
  node main.ts --serve 8080
`;

function parseArgs(argv: string[]): RadarOptions & { selftest: boolean; help: boolean } {
  const opts: RadarOptions & { selftest: boolean; help: boolean } = {
    chain: "solana",
    limit: 15,
    discover: 40,
    minLiquidity: 0,
    json: false,
    search: null,
    watchSeconds: 0,
    servePort: 0,
    selftest: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--chain":
        opts.chain = next();
        break;
      case "--limit":
        opts.limit = Number(next());
        break;
      case "--discover":
        opts.discover = Number(next());
        break;
      case "--min-liquidity":
        opts.minLiquidity = Number(next());
        break;
      case "--search":
        opts.search = next();
        break;
      case "--json":
        opts.json = true;
        break;
      case "--watch":
        opts.watchSeconds = Number(next());
        break;
      case "--serve":
        opts.servePort = Number(next());
        break;
      case "--selftest":
        opts.selftest = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg} (see --help)`);
    }
  }

  if (!Number.isFinite(opts.limit) || opts.limit <= 0) {
    throw new Error("--limit must be a positive number");
  }
  if (!Number.isFinite(opts.discover) || opts.discover <= 0) {
    throw new Error("--discover must be a positive number");
  }
  if (opts.watchSeconds !== 0 && (!Number.isFinite(opts.watchSeconds) || opts.watchSeconds < 10)) {
    throw new Error("--watch must be >= 10 seconds (DexScreener rate limits)");
  }
  if (opts.servePort !== 0 && (!Number.isFinite(opts.servePort) || opts.servePort < 1 || opts.servePort > 65535)) {
    throw new Error("--serve needs a valid port");
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Selftest — deterministic unit tests (no network)
// ---------------------------------------------------------------------------

function makePair(overrides: Partial<DexPair>): DexPair {
  return {
    chainId: "solana",
    dexId: "pumpfun",
    url: "https://dexscreener.com/solana/test",
    pairAddress: "TESTPAIR",
    baseToken: { address: "TESTTOKEN", name: "Test Token", symbol: "TEST" },
    quoteToken: { address: "So111", name: "Solana", symbol: "SOL" },
    priceUsd: "0.001",
    txns: { h24: { buys: 100, sells: 100 } },
    volume: { h24: 10_000 },
    priceChange: { h1: 10, h24: 20 },
    liquidity: { usd: 50_000 },
    marketCap: 100_000,
    pairCreatedAt: Date.now() - 30 * 60_000,
    ...overrides,
  };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`selftest failed: ${message}`);
}

function approx(a: number, b: number, tolerance = 0.6): boolean {
  return Math.abs(a - b) <= tolerance;
}

function runSelftest(): void {
  const now = Date.now();

  // 1. Score is bounded 0..100.
  const strong = makePair({
    liquidity: { usd: 5_000_000 },
    volume: { h24: 10_000_000 },
    txns: { h24: { buys: 9000, sells: 1000 } },
    priceChange: { h1: 200 },
    pairCreatedAt: now - 10 * 60_000,
  });
  const strongScore = totalScore(scorePair(strong, now));
  assert(strongScore > 80 && strongScore <= 100, `strong token score ${strongScore} should be >80 and <=100`);

  // 2. Weak token scores low.
  const weak = makePair({
    liquidity: { usd: 50 },
    volume: { h24: 10 },
    txns: { h24: { buys: 1, sells: 9 } },
    priceChange: { h1: -60 },
    pairCreatedAt: now - 30 * 24 * 60 * 60_000,
  });
  const weakScore = totalScore(scorePair(weak, now));
  assert(weakScore < 30, `weak token score ${weakScore} should be <30`);

  // 3. Ranking is monotonic: better liquidity => higher score, all else equal.
  const a = totalScore(scorePair(makePair({ liquidity: { usd: 10_000 } }), now));
  const b = totalScore(scorePair(makePair({ liquidity: { usd: 500_000 } }), now));
  assert(b > a, `higher liquidity should score higher (${a} vs ${b})`);

  // 4. Flags: pump.fun + new + parabolic.
  const flags = flagPair(
    makePair({ dexId: "pumpfun", priceChange: { h1: 400 }, pairCreatedAt: now - 5 * 60_000 }),
    50,
    now,
  );
  assert(flags.includes("PUMP.FUN"), "pump.fun flag missing");
  assert(flags.includes("NEW<1H"), "NEW<1H flag missing");
  assert(flags.includes("PARABOLIC"), "PARABOLIC flag missing");

  // 5. rankPair assigns fields + buy pressure.
  const ranked = rankPair(
    makePair({ txns: { h24: { buys: 75, sells: 25 } } }),
    now,
  );
  assert(ranked.buyPressure === 0.75, `buy pressure should be 0.75, got ${ranked.buyPressure}`);
  assert(ranked.symbol === "TEST", "symbol passthrough failed");

  // 6. Table renders and contains the token.
  const table = renderTable([{ ...ranked, rank: 1 }], {
    chain: "solana",
    limit: 15,
    minLiquidity: 0,
    json: false,
    search: null,
    watchSeconds: 0,
    servePort: 0,
    discover: 40,
  });
  assert(table.includes("TEST"), "table should contain TEST symbol");
  assert(table.includes("TOKEN LAUNCH RADAR"), "table header missing");

  // 7. Arg parsing.
  const parsed = parseArgs(["--limit", "5", "--chain", "base", "--json"]);
  assert(parsed.limit === 5 && parsed.chain === "base" && parsed.json, "arg parsing failed");

  // 8. logScale saturates at cap.
  assert(logScale(1_000_000, 1_000_000) === 1, "logScale should saturate at cap");
  assert(logScale(0, 1_000_000) === 0, "logScale(0) should be 0");

  console.log("selftest: 8 checks passed");
  console.log(`  strong score=${strongScore} weak score=${weakScore} (bounds OK)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runOnce(opts: RadarOptions): Promise<void> {
  const ranked = await buildRanking(opts);
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          chain: opts.chain,
          source: "DexScreener public API",
          tokens: ranked,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(renderTable(ranked, opts));
  }
}

async function main(): Promise<void> {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    console.error(HELP);
    process.exitCode = 2;
    return;
  }

  if (opts.help) {
    console.log(HELP);
    return;
  }

  if (opts.selftest) {
    try {
      runSelftest();
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
    return;
  }

  if (opts.servePort > 0) {
    await serveDashboard(opts);
    return;
  }

  if (opts.watchSeconds > 0) {
    for (;;) {
      console.clear();
      try {
        await runOnce(opts);
      } catch (err) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
      console.log(`\nRefreshing in ${opts.watchSeconds}s… (Ctrl+C to stop)`);
      await sleep(opts.watchSeconds * 1000);
    }
  }

  try {
    await runOnce(opts);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

await main();
