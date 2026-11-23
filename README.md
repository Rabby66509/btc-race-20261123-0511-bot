# Washout rebound, two trades

A patient trend rider for the make.fun BTC race
(`btc-race-24h-20261123-0511`): it trades Coinbase Wrapped BTC (cbBTC) on
1-minute on-chain bars with $1,000 of paper money.

## Strategy

Bitcoin's 24-hour windows are won by catching one real move, not by
churning. This bot waits for a confirmed move, rides it with a wide
trailing stop, and otherwise sits in cash — at most three round trips per
window, so the ~26 bps a round trip costs in fees, slippage and impact
never eats the move.

- **Breakout entry:** the close prints a new 30-bar high — the trend has
  turned up. Buy with the whole cash balance.
- **Dip-switch entry:** the close sits at least 1% below the trailing
  240-bar high (a washout) but has bounced at least 0.1% off the trailing
  15-bar low (the washout is turning) — and that high was set within the
  last 120 bars, so it is a pullback inside a live uptrend, not the tail
  of a long decline. Buy with the whole cash balance.
- **Trailing-stop exit:** the close falls 2% below the highest close since
  the entry. Sell the whole position.
- **Hard-stop exit:** the close is 2% below the entry fill price. Sell.
- **Cooldown:** 60 bars after a sell before the next entry.

## Dev-window result (local grade, kit's own grader)

- Net PnL: **+$31.93** on the frozen dev window (2 trades: 1 buy, flattened
  at the window end), max drawdown 1.98% — comfortably above the $0 dev
  gate. Buy at bar 54 on the early breakout, ride the trend to the end.
- Two runs on the same data produce byte-identical action logs.

## How it runs

`main.ts` (Node 22, no dependencies, standard library only) speaks
`agent-fun/bars-replay/v1`: newline-delimited JSON on stdin/stdout, one
reply per batch echoing its `seq`. No network, no wall clock, no files, no
randomness — every decision comes from the bars, fills and account the
harness sends.

## License

MIT — see `LICENSE`.
