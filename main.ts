// Washout rebound, two trades — a patient trend rider for cbBTC.
//
// Idea: Bitcoin's 24-hour windows are won by catching one real move, not by
// churning. This bot waits for a confirmed move, rides it with a wide
// trailing stop, and otherwise sits in cash. It makes at most three round
// trips in a window, so fees (about 26 bps a round trip) never eat the move.
//
// Entries (flat only, at most 3 round trips, 60-bar cooldown after a sell):
//   1. Breakout: the close prints a new 30-bar high — the trend has turned
//      up and confirmed itself. Buy the whole cash balance.
//   2. Dip-switch: the close sits at least 1% below the trailing 240-bar
//      high (a washout) but has bounced at least 0.1% off the trailing
//      15-bar low (the washout is turning) — and that high was set within
//      the last 120 bars, so the washout is a pullback inside a live
//      uptrend, not the tail of a long decline. Buy the whole cash balance.
// Exits (holding):
//   1. Trailing stop: the close falls 2% below the highest close since the
//      entry — the move is over. Sell the whole position.
//   2. Hard stop: the close is 2% below the entry fill price. Sell.
// Everything still held when the window ends is flattened by the harness.
//
// Protocol: agent-fun/bars-replay/v1, newline-delimited JSON on stdin and
// stdout. One reply per batch, echoing its seq. No network, no wall clock,
// no files, no randomness: every decision comes from the bars, the fills
// and the account the harness sends, so two runs on the same data answer
// byte for byte the same. All prices are integer units at price_scale 5;
// comparisons are ratios, computed in plain numbers.

const SYMBOL = "CBBTC";
const MAX_SLIPPAGE_BPS = 300;
const BREAKOUT_BARS = 30;
const DIP_LOOKBACK = 240;
const DIP_FRESH_BARS = 120;
const DIP_PCT = 0.01;
const REBOUND_LOOKBACK = 15;
const REBOUND_PCT = 0.001;
const TRAIL_PCT = 0.02;
const STOP_PCT = 0.02;
const COOLDOWN_BARS = 60;
const MAX_ROUND_TRIPS = 3;
const MIN_HISTORY = 30;

let warmupBars = 0;
let closes = [];
let orderNo = 0;
let holding = false;
let entryPrice = 0;
let peak = 0;
let lastSellSeq = -1000000;
let roundTrips = 0;

function maxOf(arr, from, to) {
  let m = -Infinity;
  for (let i = from; i < to; i++) if (arr[i] > m) m = arr[i];
  return m;
}

function minOf(arr, from, to) {
  let m = Infinity;
  for (let i = from; i < to; i++) if (arr[i] < m) m = arr[i];
  return m;
}

function argmaxOf(arr, from, to) {
  let m = -Infinity;
  let idx = from;
  for (let i = from; i < to; i++) if (arr[i] > m) { m = arr[i]; idx = i; }
  return idx;
}

function decide(batch) {
  const orders = [];
  const bar = (batch.bars || []).find((b) => b.symbol === SYMBOL);
  if (!bar) return orders;
  const close = Number(bar.c);
  closes.push(close);
  const seen = closes.length;

  // Settle the fills this batch reports, then read the account as truth.
  const fills = batch.fills || [];
  for (const f of fills) {
    if (f.status !== "filled") continue;
    if (f.side === "buy" && f.symbol === SYMBOL) {
      entryPrice = Number(f.price);
      peak = close;
    }
    if (f.side === "sell" && f.symbol === SYMBOL) {
      lastSellSeq = batch.seq;
      roundTrips += 1;
    }
  }
  const account = batch.account || { cash_quote_units: "0", positions: [] };
  const pos = (account.positions || []).find((p) => p.symbol === SYMBOL);
  const qty = pos ? Number(pos.qty) : 0;
  const wasHolding = holding;
  holding = qty > 0;
  if (holding && !wasHolding) {
    // Position opened on this batch; cost basis is the fallback entry.
    if (!entryPrice && pos) {
      entryPrice = (Number(pos.cost_quote_units) * 1e7) / qty;
    }
    peak = close;
  }
  if (holding && close > peak) peak = close;

  if (seen < MIN_HISTORY) return orders;
  if (batch.seq < warmupBars) return orders;

  if (holding) {
    const gain = close / entryPrice - 1;
    const trailDd = (peak - close) / peak;
    if (trailDd >= TRAIL_PCT || gain <= -STOP_PCT) {
      orderNo += 1;
      orders.push({
        side: "sell",
        client_id: "s" + orderNo,
        symbol: SYMBOL,
        qty: String(pos.qty),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }
    return orders;
  }

  // Flat: look for an entry.
  if (roundTrips >= MAX_ROUND_TRIPS) return orders;
  if (batch.seq - lastSellSeq < COOLDOWN_BARS) return orders;

  const hi30 = maxOf(closes, Math.max(0, seen - 1 - BREAKOUT_BARS), seen - 1);
  const breakout = close > hi30;
  const hi240 = maxOf(closes, Math.max(0, seen - DIP_LOOKBACK), seen);
  const hi240Idx = argmaxOf(closes, Math.max(0, seen - DIP_LOOKBACK), seen);
  const lo15 = minOf(closes, Math.max(0, seen - REBOUND_LOOKBACK), seen);
  const dipSwitch =
    seen - 1 - hi240Idx <= DIP_FRESH_BARS &&
    (hi240 - close) / hi240 >= DIP_PCT &&
    (close - lo15) / lo15 >= REBOUND_PCT;

  if (breakout || dipSwitch) {
    orderNo += 1;
    orders.push({
      side: "buy",
      client_id: "b" + orderNo,
      symbol: SYMBOL,
      notional_quote_units: String(account.cash_quote_units),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
  }
  return orders;
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type === "hello") {
      warmupBars = msg.warmup_bars || 0;
    } else if (msg.type === "batch") {
      const orders = decide(msg);
      process.stdout.write(
        JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n"
      );
    } else if (msg.type === "done") {
      process.exit(0);
    }
  }
});
