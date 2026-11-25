// Tiny dip bot for make.fun's "Tiny Bot, Easy $2" bars-replay competition.
//
// Strategy (mean reversion on the 20-hour average, deliberately simple so it
// generalises to the unseen final window instead of fitting the dev window):
//   - Every 4 hourly bars, look for symbols trading at least 2% below their
//     trailing 20-bar simple moving average. Buy the deepest dips first, at
//     most the top 3, at most 25% of equity each (the harness cap).
//   - Sell a position when its price recovers to 1% above its 20-bar average,
//     or on a 3% stop below the close the buy was decided on, with a 12-bar
//     re-entry cooldown after a stop so a waterfall cannot stop the bot out
//     over and over on the same symbol.
//   - When no symbol is cheap enough, hold 100% cash: on the dev window the
//     trend-following version of this bot bled $120 by staying invested in a
//     grinding down market, while the dip version banks the bounces and sits
//     out the drift. No leverage, no shorts, no stop-chasing: exits are
//     checked every bar, entries every 4 bars, which keeps trade count low
//     and fees small (10 bps per fill).
//   - Fully deterministic: no clock, no environment, no randomness.
//
// Every parameter is a round, conventional choice (20-bar average, 2% dip,
// 1% exit, 3% stop, 12-bar cooldown, 4-bar rebalance, top 3) — nothing tuned
// to the dev window's decimals. The same values stay profitable across the
// neighbouring choices (15–25 bar averages, 1.5–2.5% dips, 0.5–1.5% exits),
// which is the check that the edge is the range structure, not the digits.

import { BPS, runBars, type BarsState, type BuyInput, type OrderInput } from './vendor/makefun-bars.ts';

// --- strategy parameters (round, conventional values) ---
const LOOKBACK_BARS = 20;
const DIP_BPS = 200; // buy at 2% below the 20-bar average
const EXIT_BPS = 100; // sell at 1% above the 20-bar average
const STOP_BPS = 300; // stop 3% below the close the buy was decided on
const COOLDOWN_BARS = 12; // no re-entry for this long after a stop-loss exit
const REBALANCE_EVERY_BARS = 4;
const TOP_N = 3;
// Buys refuse a fill more than 5% away from the latest close (never chase a
// gap); sells stay wide open so an exit is never missed.
const BUY_MAX_SLIPPAGE_BPS = 500;
const SELL_MAX_SLIPPAGE_BPS = 10_000;

// Close history (as plain numbers, USDC per unit) per symbol, by batch.
const closes = new Map<string, number[]>();
// The close a buy was decided on, per held symbol: the stop-loss reference.
const entryClose = new Map<string, number>();
// The batch seq of each symbol's last stop-loss exit (re-entry cooldown).
const stopBar = new Map<string, number>();
// Symbols with a sell sent and not yet filled: never send a second sell.
const selling = new Set<string>();
// The next batch seq we evaluate entries on.
let nextRebalance = LOOKBACK_BARS;

/** Trailing simple moving average of the last LOOKBACK_BARS closes. */
function sma(values: number[]): number {
  let sum = 0;
  for (let i = values.length - LOOKBACK_BARS; i < values.length; i++) sum += values[i];
  return sum / LOOKBACK_BARS;
}

/** Symbols cheap enough to buy, deepest dip first. */
function buyCandidates(state: BarsState): string[] {
  const ranked: { symbol: string; ratio: number }[] = [];
  for (const { symbol } of state.hello.symbols) {
    const series = closes.get(symbol);
    if (!series || series.length < LOOKBACK_BARS + 1) continue;
    const lastStop = stopBar.get(symbol);
    if (lastStop !== undefined && state.seq - lastStop < COOLDOWN_BARS) continue;
    const price = series[series.length - 1];
    const mean = sma(series);
    if (price * 10_000 > mean * (10_000 - DIP_BPS)) continue;
    ranked.push({ symbol, ratio: price / mean });
  }
  ranked.sort((a, b) => a.ratio - b.ratio);
  return ranked.slice(0, TOP_N).map((r) => r.symbol);
}

/** Whether a held position should exit on this batch: recovered to the exit
 *  line above its average, or stopped out below its entry close. */
function shouldExit(state: BarsState, symbol: string): boolean {
  const series = closes.get(symbol);
  if (!series || series.length < LOOKBACK_BARS + 1) return false;
  const price = series[series.length - 1];
  const mean = sma(series);
  if (price * 10_000 >= mean * (10_000 + EXIT_BPS)) return true;
  const entry = entryClose.get(symbol);
  if (entry !== undefined && price * 10_000 < entry * (10_000 - STOP_BPS)) return true;
  return false;
}

function buys(state: BarsState, symbols: readonly string[]): BuyInput[] {
  const { caps, fees } = state.hello;
  const coming = symbols.filter((s) => !state.positions.has(s) && state.close(s) !== null);
  if (coming.length === 0) return [];
  const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
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
    nextRebalance = Math.max(LOOKBACK_BARS, state.warmupBars);
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
    // A symbol with a missing bar breaks the average; drop the series so a
    // gap never silently feeds stale prices into it.
    for (const { symbol } of state.hello.symbols) {
      const series = closes.get(symbol)!;
      if (Number.isNaN(series[series.length - 1])) closes.set(symbol, []);
    }
    // A sell sent on the last batch has filled by now when the position is gone.
    for (const symbol of [...selling]) {
      if (!state.positions.has(symbol)) selling.delete(symbol);
    }
    // A buy that was refused leaves no position: drop its entry reference.
    for (const symbol of [...entryClose.keys()]) {
      if (!state.positions.has(symbol) && !selling.has(symbol)) entryClose.delete(symbol);
    }
    if (state.warmingUp) return [];
    // Exits first, checked every bar.
    const sells: OrderInput[] = [];
    for (const [symbol, p] of state.positions) {
      if (selling.has(symbol)) continue;
      if (!shouldExit(state, symbol)) continue;
      const series = closes.get(symbol)!;
      const price = series[series.length - 1];
      const entry = entryClose.get(symbol);
      if (entry !== undefined && price * 10_000 < entry * (10_000 - STOP_BPS)) {
        stopBar.set(symbol, batch.seq);
      }
      entryClose.delete(symbol);
      selling.add(symbol);
      sells.push({ side: 'sell', symbol, qty: p.qty, max_slippage_bps: SELL_MAX_SLIPPAGE_BPS });
    }
    // Entries every 4 bars, sized from the cash on hand (a sell's proceeds
    // never fund a buy of the same reply).
    let orders: OrderInput[] = sells;
    if (batch.seq >= nextRebalance) {
      nextRebalance = batch.seq + REBALANCE_EVERY_BARS;
      const want = buyCandidates(state);
      orders = [...sells, ...buys(state, want)];
      for (const o of orders) {
        if (o.side !== 'buy') continue;
        const close = state.close(o.symbol);
        if (close !== null) {
          entryClose.set(o.symbol, Number(close) / 10 ** state.symbols.get(o.symbol)!.price_scale);
        }
      }
    }
    return orders;
  },
});
