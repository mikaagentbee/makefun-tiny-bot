// Tiny trend bot for make.fun's "Tiny Bot, Easy $2" bars-replay competition.
//
// Strategy (simple and deliberately hard to overfit):
//   - Every 4 hourly bars, rank the 7 symbols by trailing 12-bar momentum,
//     but only among symbols in an uptrend: fast EMA (10h) above slow EMA (30h)
//     and price above the slow EMA.
//   - Hold at most the top 3. Sell anything that falls out of the top 3.
//   - Regime filter: an equal-weight index of the whole universe has its own
//     10h/30h EMA pair. When the index is in a downtrend we still trade, but
//     each new position is one-third size (about 8.3% of equity instead of
//     25%), so a grinding down market costs us far less than buy-and-hold
//     while a real uptrend still gets us nearly fully invested in the
//     strongest names.
//   - No leverage, no shorts, no stop-chasing: exits happen at rebalances,
//     which keeps trade count low and fees small (10 bps per fill).
//   - Fully deterministic: no clock, no environment, no randomness.
//
// The final window is unseen data collected after the deadline, so every
// parameter here is a round, conventional choice (10/30 EMA, 12-bar momentum,
// 4-bar rebalance, top 3, 25% weight cap from the harness caps) rather than
// something tuned to the dev window's decimals.

import { BPS, runBars, type BarsState, type BuyInput, type OrderInput } from './vendor/makefun-bars.ts';

// --- strategy parameters (round, conventional values) ---
// Slower pair (10h/30h): on hourly bars it waits for a real trend instead of
// reacting to every 8-hour wiggle, which cut whipsaw losses on the dev window
// (fewer, later entries; drawdown roughly halved) while still rotating into
// the strongest names when the universe trends up.
const FAST_EMA_BARS = 10;
const SLOW_EMA_BARS = 30;
const MOMENTUM_BARS = 12;
const REBALANCE_EVERY_BARS = 4;
const TOP_N = 3;
// Buys refuse a fill more than 5% away from the latest close (never chase a
// gap); sells stay wide open so an exit is never missed.
const BUY_MAX_SLIPPAGE_BPS = 500;
const SELL_MAX_SLIPPAGE_BPS = 10_000;

// Close history (as plain numbers, USDC per unit) per symbol, by batch.
const closes = new Map<string, number[]>();
// Symbols to buy on the next batch, chosen on a rebalance bar whose sells
// have now filled (a sell's proceeds never fund a buy of the same reply).
let entering: string[] | null = null;
// The next batch seq we rebalance on.
let nextRebalance = SLOW_EMA_BARS;

function emaAt(values: number[], span: number): number {
  const alpha = 2 / (span + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = alpha * values[i] + (1 - alpha) * e;
  return e;
}

/** The universe index: each symbol's close divided by its first close, averaged. */
function indexSeries(state: BarsState): number[] {
  const n = closes.get(state.hello.symbols[0].symbol)?.length ?? 0;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (const { symbol } of state.hello.symbols) {
      const series = closes.get(symbol);
      if (series && series[i] !== undefined && series[0] > 0) {
        sum += series[i] / series[0];
        count++;
      }
    }
    idx.push(count > 0 ? sum / count : 1);
  }
  return idx;
}

/** Top symbols by trailing momentum among those in an uptrend, best first. */
function targetSymbols(state: BarsState): string[] {
  const ranked: { symbol: string; momentum: number }[] = [];
  for (const { symbol } of state.hello.symbols) {
    const series = closes.get(symbol);
    if (!series || series.length < SLOW_EMA_BARS + 1) continue;
    const fast = emaAt(series, FAST_EMA_BARS);
    const slow = emaAt(series, SLOW_EMA_BARS);
    const price = series[series.length - 1];
    if (fast <= slow || price <= slow) continue;
    const back = series[series.length - 1 - MOMENTUM_BARS];
    if (back <= 0) continue;
    ranked.push({ symbol, momentum: price / back - 1 });
  }
  ranked.sort((a, b) => b.momentum - a.momentum);
  return ranked.slice(0, TOP_N).map((r) => r.symbol);
}

/** True when the whole-universe index is in an uptrend (fast EMA > slow EMA). */
function regimeUp(state: BarsState): boolean {
  const idx = indexSeries(state);
  if (idx.length < SLOW_EMA_BARS + 1) return false;
  return emaAt(idx, FAST_EMA_BARS) > emaAt(idx, SLOW_EMA_BARS);
}

function buys(state: BarsState, symbols: readonly string[]): BuyInput[] {
  const { caps, fees } = state.hello;
  const coming = symbols.filter((s) => !state.positions.has(s) && state.close(s) !== null);
  if (coming.length === 0) return [];
  // Weight cap per symbol, cut to one third while the universe trends down.
  const weightBps = regimeUp(state)
    ? BigInt(caps.max_weight_bps)
    : BigInt(caps.max_weight_bps) / 3n;
  const byWeight = (weightBps * state.equity) / BPS;
  const even = state.cash / BigInt(coming.length);
  const slice = even < byWeight ? even : byWeight;
  if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) return [];
  return coming.map((symbol) => ({
    side: 'buy',
    symbol,
    notional_quote_units: slice,
    max_slippage_bps: BUY_MAX_SLIPPAGE_BPS,
  }));
}

await runBars({
  onHello(state) {
    nextRebalance = Math.max(SLOW_EMA_BARS, state.warmupBars);
  },
  onBatch(state, batch) {
    // Record this batch's closes (null where a symbol has no bar yet).
    for (const { symbol } of state.hello.symbols) {
      const close = state.close(symbol);
      const meta = state.symbols.get(symbol)!;
      const series = closes.get(symbol) ?? [];
      series.push(close === null ? NaN : Number(close) / 10 ** meta.price_scale);
      closes.set(symbol, series);
    }
    // A symbol with a missing bar breaks the EMA chain; drop the series so a
    // gap never silently feeds stale prices into the averages.
    for (const { symbol } of state.hello.symbols) {
      const series = closes.get(symbol)!;
      if (Number.isNaN(series[series.length - 1])) closes.set(symbol, []);
    }
    if (state.warmingUp) return [];
    if (entering !== null) {
      const orders = buys(state, entering);
      entering = null;
      return orders;
    }
    if (batch.seq < nextRebalance) return [];
    nextRebalance = batch.seq + REBALANCE_EVERY_BARS;
    const want = targetSymbols(state);
    const sells: OrderInput[] = [...state.positions]
      .filter(([symbol]) => !want.includes(symbol))
      .map(([symbol, p]) => ({
        side: 'sell',
        symbol,
        qty: p.qty,
        max_slippage_bps: SELL_MAX_SLIPPAGE_BPS,
      }));
    if (sells.length === 0) return buys(state, want);
    entering = want;
    return sells;
  },
});
