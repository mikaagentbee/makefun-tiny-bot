# Tiny Trend Bot

A small, robust paper-trading bot for make.fun's "Tiny Bot, Easy $2: Beat
Buy-and-Hold on Solana" bounty. It trades hourly Solana bars (SOL, WETH,
JITOSOL, RAY, FARTCOIN, POPCAT, WIF) through the `agent-fun/bars-replay/v1`
line protocol — see `main.ts`, which runs as `node main.ts` on Node 22+.

## Strategy

Trend-following with a regime filter, kept deliberately simple so it
generalises to the unseen final window instead of fitting the dev window:

- Every 4 hourly bars, rank the 7 symbols by trailing 12-bar momentum, but
  only among symbols in an uptrend: fast EMA (10h) above slow EMA (30h) and
  price above the slow EMA.
- Hold at most the top 3. Sell anything that falls out of the top 3.
- Regime filter: an equal-weight index of the whole universe has its own
  10h/30h EMA pair. When the index trends down, new positions are
  one-third size (about 8.3% of equity instead of 25%), so a grinding down
  market costs far less than buy-and-hold while a real uptrend still gets
  nearly fully invested in the strongest names.
- No leverage, no shorts. Buys refuse fills more than 5% from the latest
  close; sells stay wide open so an exit is never missed. Fully
  deterministic: no clock, no environment, no randomness.

## Dev-window grade (kit's `grade-local`, process driver)

| Bot | Net PnL (USDC) | Trades | Max drawdown |
| --- | --- | --- | --- |
| This bot | **-120.12** | 18 | 1.3% |
| ema-cross (best house baseline) | -173.04 | 28 | 2.5% |
| momentum | -268.23 | 19 | 5.7% |
| buy-and-hold | -869.34 | 7 | 10.9% |
| hold-cash | 0.00 | 0 | 0.0% |

The dev window is a down market (every symbol fell 8–14%), so every
trend-following entry loses a little; the edge is losing far less than
buy-and-hold by sitting mostly in cash while the trend is down, and
rotating into the strongest names when it turns up. All parameters are
round, conventional values (10/30 EMA, 12-bar momentum, 4-bar rebalance,
top 3) — nothing tuned to the dev window's decimals.

## Layout

- `main.ts` — the bot (entrypoint)
- `vendor/makefun-bars.ts` — the kit's bars-replay shim, copied verbatim
- `.makefun/owner.json` — payout wallet claim file
- `LICENSE` — MIT
