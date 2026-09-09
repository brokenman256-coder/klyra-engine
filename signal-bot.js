// Klyra Pulse: signals from THIS venue's candles (RSI / EMA / ATR), not random copy.
function closes(candles) {
  return (candles || []).map(c => Number(c.close)).filter(n => n > 0);
}

function ema(vals, period) {
  if (vals.length < period) return null;
  const k = 2 / (period + 1);
  let e = vals.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
  return e;
}

function rsi(vals, period) {
  if (vals.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = vals.length - period; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function atr(candles, period) {
  if (!candles || candles.length < period + 1) return null;
  const slice = candles.slice(-period);
  let sum = 0;
  for (const c of slice) sum += Number(c.high) - Number(c.low);
  return sum / period;
}

function generateSignal(symbol, asset, candles) {
  const px = Number(asset && asset.price) || 0;
  const c = candles || [];
  const vals = closes(c);
  const r = rsi(vals, 14);
  const fast = ema(vals, 9);
  const slow = ema(vals, 21);
  const range = atr(c, 14);
  const trend = asset && asset.trend;

  let signal = "Hold";
  let strength = 0.42;
  let reason = "Klyra Pulse waiting for a clean setup on our tape";

  if (r != null && r <= 32 && (trend === "bull" || (fast && slow && fast >= slow))) {
    signal = "Buy";
    strength = Math.min(0.92, 0.55 + (32 - r) / 80);
    reason = "RSI " + r.toFixed(1) + " oversold on Klyra 1m · demand holding";
  } else if (r != null && r >= 68 && (trend === "bear" || (fast && slow && fast <= slow))) {
    signal = "Sell";
    strength = Math.min(0.92, 0.55 + (r - 68) / 80);
    reason = "RSI " + r.toFixed(1) + " stretched on Klyra 1m · supply pressing";
  } else if (fast && slow && px) {
    const sep = (fast - slow) / px;
    if (sep > 0.0012) {
      signal = "Buy";
      strength = Math.min(0.84, 0.5 + sep * 80);
      reason = "9/21 EMA lift on house tape · trend continuation";
    } else if (sep < -0.0012) {
      signal = "Sell";
      strength = Math.min(0.84, 0.5 + Math.abs(sep) * 80);
      reason = "9/21 EMA fade on house tape · trend continuation";
    } else if (range && px && range / px < 0.0015) {
      reason = "Tight ATR coil on Klyra tape · wait for expansion";
    } else {
      reason = "Mixed EMA / RSI on our book · no edge yet";
    }
  }

  return {
    symbol,
    signal,
    strength: Number(strength.toFixed(2)),
    reason,
    rsi: r == null ? null : Number(r.toFixed(1)),
    emaFast: fast == null ? null : Number(fast.toFixed(4)),
    emaSlow: slow == null ? null : Number(slow.toFixed(4)),
    source: "klyra-pulse"
  };
}

function getSignalsForMarkets(markets, candleManager) {
  const signals = {};
  for (const [symbol, asset] of Object.entries(markets || {})) {
    if (symbol === "USDT") continue;
    const candles = candleManager && candleManager.getCandles ? candleManager.getCandles(symbol, "1m") : [];
    signals[symbol] = generateSignal(symbol, asset, candles);
  }
  return signals;
}

module.exports = { generateSignal, getSignalsForMarkets };
