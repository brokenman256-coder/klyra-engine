// Klyra composite tape. Anchors on public spot, then applies a persistent
// house index so our prints never line up tick-for-tick with Binance/Bybit/Coinbase.
const https = require("https");
const crypto = require("crypto");
const brand = require("./brand");

const IDS = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  BNB: "binancecoin",
  XRP: "ripple",
  DOGE: "dogecoin",
  AVAX: "avalanche-2",
  LINK: "chainlink",
  ADA: "cardano",
  TON: "the-open-network"
};

async function pullFxAndMetals() {
  const out = {};
  try {
    const fx = await getJson("https://open.er-api.com/v6/latest/USD");
    if (fx && fx.rates) {
      if (fx.rates.INR) out.USDINR = Number(fx.rates.INR);
      if (fx.rates.EUR) out.EURUSD = 1 / Number(fx.rates.EUR);
      if (fx.rates.GBP) out.GBPUSD = 1 / Number(fx.rates.GBP);
    }
  } catch (e) {}
  try {
    const g = await getJson("https://api.gold-api.com/price/XAU");
    if (g && Number(g.price) > 0) out.GOLD = Number(g.price);
  } catch (e) {}
  try {
    const s = await getJson("https://api.gold-api.com/price/XAG");
    if (s && Number(s.price) > 0) out.SILVER = Number(s.price);
  } catch (e) {}
  return out;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "KlyraTape/3.0" }, timeout: 9000 }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function indexBias(symbol) {
  const h = crypto.createHash("sha256").update(brand.engine + ":" + symbol).digest();
  const n = h.readUInt32BE(0) / 0xffffffff;
  return 0.0016 + n * 0.0028; // 0.16%–0.44% persistent lift unique to this venue
}

function sessionWave(symbol, now) {
  const h = crypto.createHash("sha256").update(brand.engine + ":wave:" + symbol).digest().readUInt16BE(0);
  const period = 7 * 60 * 1000 + (h % 5) * 60 * 1000;
  return Math.sin((now / period) * Math.PI * 2) * 0.00035;
}

async function pullCoinGecko() {
  const ids = Object.values(IDS).join(",");
  const url = "https://api.coingecko.com/api/v3/simple/price?ids=" + ids + "&vs_currencies=usd";
  const data = await getJson(url);
  const out = {};
  for (const [sym, id] of Object.entries(IDS)) {
    const px = data && data[id] && Number(data[id].usd);
    if (px > 0) out[sym] = px;
  }
  return out;
}

async function pullKraken() {
  const map = { XXBTZUSD: "BTC", XETHZUSD: "ETH", SOLUSD: "SOL", XDGUSD: "DOGE", ADAUSD: "ADA", LINKUSD: "LINK" };
  const data = await getJson("https://api.kraken.com/0/public/Ticker?pair=" + Object.keys(map).join(","));
  const out = {};
  if (!data || !data.result) return out;
  for (const [pair, sym] of Object.entries(map)) {
    const row = data.result[pair];
    const px = row && row.c && Number(row.c[0]);
    if (px > 0) out[sym] = px;
  }
  return out;
}

async function pull() {
  try {
    return await pullCoinGecko();
  } catch (e) {
    return await pullKraken();
  }
}

function klyraMid(symbol, spot, now) {
  if (!spot || spot <= 0) return null;
  return spot * (1 + indexBias(symbol) + sessionWave(symbol, now));
}

function attach(marketManager) {
  const run = async () => {
    try {
      const px = Object.assign({}, await pull(), await pullFxAndMetals());
      const now = Date.now();
      for (const [sym, spot] of Object.entries(px)) {
        const mid = klyraMid(sym, spot, now);
        if (mid > 0) marketManager.externalPrices[sym] = mid;
      }
    } catch (e) {}
  };
  run();
  // In serverless (Vercel), a setInterval here never gets cleared and each
  // cold-start instance piles on its own copy, hammering external APIs and
  // MongoDB more with every new instance until things start failing. Only
  // run the persistent loop on a real long-lived process.
  if (!process.env.VERCEL) setInterval(run, 12000);
}

module.exports = { attach, klyraMid, indexBias };
