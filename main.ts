// polymarket-nvidia-ceo-forecast-01 entry (Node 22, standard library only):
// per-market recency-weighted persistence forecast of Polymarket's
// "Next CEO of NVIDIA?" Yes prices, one 5-quantile row per minute for the
// 240 minutes after each checkpoint.
//
// Model, validated on the kit's 6 practice cases (mean pinball loss
// 0.2717 in percentage points vs the house baseline's 0.3636):
//   q_tau(h) = clamp(x + z_tau * sigma * h^0.45, 0, 1), rounded to 6 decimals
// where x is the market's last price at the checkpoint, z_tau the standard
// normal's quantile at each level (0.05, 0.25, 0.5, 0.75, 0.95), and sigma
// the market's own 1-minute return volatility over its last 120 minutes,
// clamped to [0.0005, 0.005].
//
// Why this shape, from the practice data:
// - Prices are steppy: mostly flat for minutes, then a tick, now and then
//   a jump that usually snaps back. A 72-hour volatility estimate is
//   dominated by a wild early regime and is ~10x too wide; the last 2
//   hours track the regime the next 4 hours actually live in.
// - The cap stops one recent jump from blowing the spread up; the floor
//   keeps a totally quiet hour from forecasting a zero spread, so a jump
//   still lands inside the outer quantiles.
// - h^0.45 instead of sqrt(h): jumps mean-revert, so the 4-hour spread
//   grows slower than a random walk's. The median stays at x: every
//   drift tried on the practice (recent slope, sum-to-one pull) made the
//   loss worse, so there is no drift term.
//
// The program reads every <id>.in in the input directory (the grader runs
// one case at a time, with only that case's file there) and writes
// <id>.out to the output directory: {"forecasts":[{"id","q"}]}, every
// market exactly once, q exactly horizon_minutes rows, each row one finite
// number in [0,1] per quantile level, non-decreasing. It runs offline,
// with no network, no clock and no randomness: the same input always
// writes the same bytes.
//
// Outside the grader's container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level, to 6 decimals. */
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];
/** Minutes of recent 1-minute returns the per-market volatility is read from. */
const VOL_WINDOW_MIN = 120;
/** The per-market volatility's floor and cap, in price units per minute. */
const SIGMA_FLOOR = 0.0005;
const SIGMA_CAP = 0.005;
/** The spread grows like h ** SPREAD_ALPHA, slower than a random walk's sqrt(h). */
const SPREAD_ALPHA = 0.45;

interface CaseMarket {
  id: string;
  prices: number[];
}

interface Case {
  horizon_minutes: number;
  quantiles: number[];
  markets: CaseMarket[];
}

/** x clamped to [0,1] and rounded to 6 decimals (0, never -0). */
const price6 = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 1e6) / 1e6 + 0;

/** One market's 1-minute return volatility over its last VOL_WINDOW_MIN minutes. */
function recentSigma(prices: number[]): number {
  const start = Math.max(1, prices.length - VOL_WINDOW_MIN);
  let n = 0;
  let mean = 0;
  let m2 = 0;
  for (let i = start; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    n++;
    const delta = d - mean;
    mean += delta / n;
    m2 += delta * (d - mean);
  }
  const sigma = n > 1 ? Math.sqrt(m2 / n) : 0;
  return Math.min(SIGMA_CAP, Math.max(SIGMA_FLOOR, sigma));
}

/** The forecast of one market: horizon rows of the five quantiles around its last price. */
function forecast(m: CaseMarket, horizon: number): number[][] {
  if (m.prices.length === 0) throw new Error(`market ${m.id} has no prices`);
  const x = m.prices[m.prices.length - 1] as number;
  const sigma = recentSigma(m.prices);
  const rows: number[][] = [];
  for (let h = 1; h <= horizon; h++) {
    const spread = sigma * Math.pow(h, SPREAD_ALPHA);
    const row = Z.map((z) => price6(x + z * spread));
    // The grader requires non-decreasing rows: clamping and rounding are
    // monotone, so this is a no-op in practice, but it guarantees the
    // invariant even at the [0,1] boundary for every market.
    for (let j = 1; j < row.length; j++) {
      if (row[j] < row[j - 1]) row[j] = row[j - 1];
    }
    rows.push(row);
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.quantiles.length !== QUANTILES.length || c.quantiles.some((t, j) => t !== QUANTILES[j])) throw new Error(`${file} asks for quantiles ${JSON.stringify(c.quantiles)}, not ${JSON.stringify(QUANTILES)}`);
  const forecasts = c.markets.map((m) => ({ id: m.id, q: forecast(m, c.horizon_minutes) }));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts })}\n`);
}
