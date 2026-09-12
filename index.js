const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const store = require("./store");
const { User, Trade, BotSetting, Order } = require("./models");
const control = require("./control");
const walletAuth = require("./wallet-auth");
const prop = require("./prop");
const signalBot = require("./signal-bot");
const brand = require("./brand");
const pay = require("./pay");
const live = require("./live");
const upi = require("./upi");
const emailer = require("./email");
const feed = require("./feed");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("JWT_SECRET missing or too short. Set it in backend/.env");
  process.exit(1);
}
const ROUNDS = Math.max(10, Number(process.env.BCRYPT_ROUNDS || 12));
const LOCK_TRIES = 40;
const LOCK_MS = 60 * 1000;

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
const ALLOW = String(process.env.CORS_ORIGINS || "*").split(",").map(s => s.trim()).filter(Boolean);
const io = new Server(server, { cors: { origin: ALLOW.includes("*") ? true : ALLOW, methods: ["GET", "POST"] } });
require("./harden").attach(app);
app.use(cors({ origin: ALLOW.includes("*") ? true : ALLOW, credentials: true }));
app.use(express.json({ limit: "64kb" }));

const SERVERLESS = !!process.env.VERCEL;
let lastPulse = 0;
let bootPromise = null;
function ensureBoot() {
  if (!bootPromise) bootPromise = bootstrap();
  return bootPromise;
}
let propApi = null;
async function pulse() {
  await ensureBoot();
  const now = Date.now();
  if (now - lastPulse < 1600) return;
  lastPulse = now;
  if (await store.isDead()) return;
  await control.tick(marketManager);
  marketManager.updateMarket();
  ticks++;
  if (ticks % 10 === 0) await store.saveMarkets(marketManager.snapshot());
  // On a real long-lived process, feed.attach() already runs its own
  // interval. On Vercel, that interval never fires between cold starts, so
  // the per-request pulse is the only thing keeping real prices from going
  // stale — refresh them here on the same rough ~12s cadence.
  if (SERVERLESS && ticks % 8 === 0) feed.refresh(marketManager).catch(() => {});
  if (propApi) {
    try { await propApi.matchInvoices(); } catch (e) {}
    try { await propApi.checkChallenges(); } catch (e) {}
    try { await propApi.checkPendingOrders(); } catch (e) {}
  }
}
app.use(async (req, res, next) => {
  try { await pulse(); } catch (e) { console.error("pulse", e.message); }
  next();
});

const CODE_RED = String(process.env.CODE_RED_SECRET);
function codeRedOk(code) {
  const a = Buffer.from(String(code || ""), "utf8");
  const b = Buffer.from(CODE_RED, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
function vanish(res) {
  res.status(404).set("Content-Type", "text/plain").send("");
}
app.use(async (req, res, next) => {
  if (!(await store.isDead())) return next();
  if (req.method === "POST" && (req.path === "/api/unlock" || req.path === "/unlock")) return next();
  vanish(res);
});

class MarketManager {
  constructor() {
    this.assets = {
      BTC: { price: 64120, trend: "sideways", volatility: 22, high: 64120, low: 64120 },
      ETH: { price: 3412, trend: "sideways", volatility: 6, high: 3412, low: 3412 },
      SOL: { price: 148.4, trend: "sideways", volatility: 0.9, high: 148.4, low: 148.4 },
      BNB: { price: 582, trend: "sideways", volatility: 1.6, high: 582, low: 582 },
      XRP: { price: 0.62, trend: "sideways", volatility: 0.004, high: 0.62, low: 0.62 },
      DOGE: { price: 0.148, trend: "sideways", volatility: 0.0012, high: 0.148, low: 0.148 },
      AVAX: { price: 36.2, trend: "sideways", volatility: 0.18, high: 36.2, low: 36.2 },
      LINK: { price: 14.8, trend: "sideways", volatility: 0.08, high: 14.8, low: 14.8 },
      ADA: { price: 0.46, trend: "sideways", volatility: 0.003, high: 0.46, low: 0.46 },
      TON: { price: 5.4, trend: "sideways", volatility: 0.04, high: 5.4, low: 5.4 },
      GOLD: { price: 2348, trend: "sideways", volatility: 1.8, high: 2348, low: 2348 },
      SILVER: { price: 27.4, trend: "sideways", volatility: 0.08, high: 27.4, low: 27.4 },
      EURUSD: { price: 1.0862, trend: "sideways", volatility: 0.0008, high: 1.0862, low: 1.0862 },
      GBPUSD: { price: 1.271, trend: "sideways", volatility: 0.001, high: 1.271, low: 1.271 },
      USDINR: { price: 83.4, trend: "sideways", volatility: 0.04, high: 83.4, low: 83.4 },
      US30: { price: 39820, trend: "sideways", volatility: 28, high: 39820, low: 39820 },
      NAS100: { price: 17840, trend: "sideways", volatility: 22, high: 17840, low: 17840 },
      GER40: { price: 18420, trend: "sideways", volatility: 18, high: 18420, low: 18420 },
      CRUDE: { price: 78.6, trend: "sideways", volatility: 0.18, high: 78.6, low: 78.6 },
      USDT: { price: 1, trend: "sideways", volatility: 0, high: 1, low: 1 }
    };
    this.externalPrices = {};
    this.bias = {};
  }
  async init() {
    const saved = await store.getMarkets();
    Object.keys(this.assets).forEach(sym => {
      if (saved[sym] && saved[sym].price > 0) Object.assign(this.assets[sym], saved[sym], { halted: !!saved[sym].halted });
      this.assets[sym].halted = !!this.assets[sym].halted;
    });
  }
  setBias(b) { this.bias = b || {}; }
  getState(symbol) { return this.assets[symbol] || null; }
  snapshot() {
    const out = {};
    for (const [k, v] of Object.entries(this.assets)) {
      out[k] = { price: v.price, trend: v.trend, volatility: v.volatility, high: v.high, low: v.low, halted: !!v.halted };
    }
    return out;
  }
  updateMarket() {
    for (const symbol in this.assets) {
      const asset = this.assets[symbol];
      if (symbol === "USDT" || asset.halted) continue;
      const ext = this.externalPrices[symbol];
      if (ext > 0) {
        // A real free feed exists for this symbol (crypto via CoinGecko/
        // Kraken, EURUSD/GBPUSD/USDINR, Gold/Silver) — show that real price
        // directly. A sub-pip jitter just keeps the chart alive between the
        // feed's ~12s polls; it never moves the price away from the real
        // quote by more than noise.
        const jitter = ext * (Math.random() - 0.5) * 0.00006;
        asset.price = ext + jitter;
      } else {
        // No free real-time source exists for this symbol (indices, crude
        // oil) — simulate, honestly, rather than fabricate a "live" feed.
        let change = (Math.random() - 0.5) * asset.volatility;
        if (asset.trend === "bull") change += asset.volatility * 0.08;
        if (asset.trend === "bear") change -= asset.volatility * 0.08;
        if (this.bias[symbol]) change += asset.price * this.bias[symbol];
        asset.price = Math.max(asset.price + change, 0.01);
      }
      asset.high = Math.max(asset.high || asset.price, asset.price);
      asset.low = Math.min(asset.low || asset.price, asset.price);

      if (typeof candleManager !== 'undefined') {
        candleManager.update(symbol, asset.price);
      }
    }
    return this.snapshot();
  }
  async overrideAsset(symbol, updates) {
    if (!this.assets[symbol]) return null;
    const allow = ["price", "trend", "volatility", "halted"];
    for (const k of allow) if (updates[k] !== undefined && updates[k] !== null && updates[k] !== "") this.assets[symbol][k] = k === "halted" ? !!updates[k] : updates[k];
    if (updates.price) {
      this.assets[symbol].high = Math.max(this.assets[symbol].high, Number(updates.price));
      this.assets[symbol].low = Math.min(this.assets[symbol].low, Number(updates.price));
    }
    await store.saveMarkets(this.snapshot());
    return this.assets[symbol];
  }
}
class CandleManager {
  constructor() {
    this.candles = {}; // { symbol: { timeframe: [candles] } }
    this.timeframes = {
      "1m": 60 * 1000,
      "5m": 5 * 60 * 1000,
      "1h": 60 * 60 * 1000,
      "1d": 24 * 60 * 60 * 1000
    };
  }

  update(symbol, price) {
    const now = Date.now();
    if (!this.candles[symbol]) this.candles[symbol] = {};

    for (const [tf, duration] of Object.entries(this.timeframes)) {
      if (!this.candles[symbol][tf]) this.candles[symbol][tf] = [];

      const candles = this.candles[symbol][tf];
      const candleTime = Math.floor(now / duration) * duration;
      let lastCandle = candles[candles.length - 1];

      if (!lastCandle || lastCandle.time !== candleTime) {
        lastCandle = {
          time: candleTime,
          open: price,
          high: price,
          low: price,
          close: price
        };
        candles.push(lastCandle);
        if (candles.length > 1000) candles.shift();
      } else {
        lastCandle.high = Math.max(lastCandle.high, price);
        lastCandle.low = Math.min(lastCandle.low, price);
        lastCandle.close = price;
      }
    }
  }

  getCandles(symbol, timeframe) {
    return this.candles[symbol]?.[timeframe] || [];
  }

  snapshot() {
    return this.candles;
  }
}
const marketManager = new MarketManager();
const candleManager = new CandleManager();


const RL = {};
const locks = {};
function rl(key, limit, ms) {
  const now = Date.now();
  RL[key] = (RL[key] || []).filter(t => now - t < ms);
  if (RL[key].length >= limit) return false;
  RL[key].push(now);
  return true;
}
function ipOf(req) { return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(); }
function strong(pw) {
  return typeof pw === "string" && pw.length >= 4 && pw.length <= 128;
}
function locked(key) {
  const f = locks[key];
  if (!f) return false;
  if (f.until && Date.now() < f.until) return true;
  if (f.until && Date.now() >= f.until) { locks[key] = { n: 0, until: 0 }; return false; }
  return false;
}
function failLock(key) {
  const f = locks[key] || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= LOCK_TRIES) f.until = Date.now() + LOCK_MS;
  locks[key] = f;
  return f;
}
function sign(user) {
  return jwt.sign({ id: user._id, role: user.role, tv: user.tokenVersion || 0 }, JWT_SECRET, { expiresIn: "12h" });
}
function publicUser(u) {
  return {
    _id: u._id,
    username: u.username,
    role: u.role,
    balances: Object.assign({}, u.balances || {}),
    walletAddress: u.walletAddress || null,
    walletLinkedAt: u.walletLinkedAt || null,
    upiId: u.upiId || null,
    cryptoPayout: u.cryptoPayout || null,
    lastIp: u.lastIp || null,
    lastIpAt: u.lastIpAt || null,
    suspended: !!u.suspended,
    suspendedReason: u.suspendedReason || null,
    email: u.email || null,
    emailVerified: !!u.emailVerified
  };
}
const DUMMY = bcrypt.hashSync("not-a-real-password-dummy", 10);

function asBal(b) {
  if (!b) return {};
  if (typeof b.toObject === "function") return b.toObject();
  if (typeof Map !== "undefined" && b instanceof Map) return Object.fromEntries(b);
  return Object.assign({}, b);
}

function uniqueSpread(symbol, price) {
  const h = crypto.createHash("sha256").update(brand.engine + ":spr:" + symbol).digest().readUInt16BE(0);
  const bps = 4 + (h % 9); // 4–12 bps unique per pair
  const half = price * (bps / 20000);
  return { bid: price - half, ask: price + half, bps };
}

function synthBook(symbol, price) {
  const { bid, ask } = uniqueSpread(symbol, price);
  const bids = [], asks = [];
  for (let i = 0; i < 12; i++) {
    const step = price * (0.00018 + (i * 0.00011));
    const qty = Number((0.12 + ((i * 17 + symbol.length) % 9) * 0.08).toFixed(4));
    bids.push([Number((bid - step).toFixed(price > 20 ? 2 : 6)), qty]);
    asks.push([Number((ask + step).toFixed(price > 20 ? 2 : 6)), qty * 0.94]);
  }
  return { symbol, bids, asks };
}

async function authenticate(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const p = jwt.verify(token, JWT_SECRET);
    const u = await store.getUserById(p.id);
    if (!u) return res.status(401).json({ error: "Unauthorized" });
    if ((u.tokenVersion || 0) !== (p.tv || 0)) return res.status(401).json({ error: "Session expired. Sign in again." });
    if (u.suspended) return res.status(403).json({ error: "This account has been suspended. Contact support." });
    req.auth = { id: String(u._id), role: u.role, tv: u.tokenVersion || 0, username: u.username };
    next();
  } catch (e) {
    res.status(401).json({ error: "Invalid token" });
  }
}
function isAdmin(req, res, next) {
  if (req.auth.role !== "admin") return res.status(403).json({ error: "Forbidden: Admin only" });
  next();
}

async function executeTrade(userId, symbol, type, amount, quote) {
  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");
  const asset = marketManager.getState(symbol);
  if (!asset) throw new Error("Asset not found");
  if (asset.halted) throw new Error("Market halted");
  const qty = Number(amount);
  if (!qty || qty <= 0 || !Number.isFinite(qty)) throw new Error("Invalid amount");
  if (qty > 100000) throw new Error("Size too large");
  const cashAsset = quote === "INR" ? "INR" : "USDT";
  const spr = uniqueSpread(symbol, asset.price);
  let price = type === "BUY" ? spr.ask : spr.bid;
  if (cashAsset === "INR" && symbol !== "USDINR") {
    const inr = marketManager.getState("USDINR");
    price = price * (inr && inr.price ? inr.price : 83.4);
  }
  const cost = qty * price;
  const fee = cost * 0.001;
  const bal = asBal(user.balances);
  const cash = bal[cashAsset] || 0;
  const holdings = bal[symbol] || 0;
  if (type === "BUY") {
    if (cash < cost + fee) throw new Error("Insufficient " + cashAsset + " balance");
    bal[cashAsset] = cash - cost - fee;
    bal[symbol] = holdings + qty;
  } else if (type === "SELL") {
    if (holdings < qty) throw new Error("Insufficient " + symbol + " balance");
    bal[symbol] = holdings - qty;
    bal[cashAsset] = cash + cost - fee;
  } else {
    throw new Error("Invalid trade type");
  }
  user.balances = bal;
  await user.save();
  const trade = await Trade.create({ userId: user._id, symbol, type, amount: qty, price, total: cost, fee });
  const spreadTake = Math.abs(price - asset.price) * qty;
  store.recordRevenue({ type: "fee", amount: fee, userId: user._id, username: user.username, ref: symbol, note: type + " commission" }).catch(() => {});
  if (spreadTake > 0) store.recordRevenue({ type: "spread", amount: spreadTake, userId: user._id, username: user.username, ref: symbol, note: "bid/ask spread" }).catch(() => {});
  io.emit("admin_event", { type: "order_filled", symbol, side: type, qty, email: user.username });
  return { trade, balances: bal, fee, spread: spreadTake };
}

app.get("/api/health", (req, res) => res.json({ ok: true, engine: brand.engine, venue: brand.name, atlas: !!process.env.MONGODB_URI }));
app.get("/api/brand", (req, res) => res.json(brand));
app.get("/api/signals", (req, res) => res.json(signalBot.getSignalsForMarkets(marketManager.snapshot(), candleManager)));
app.get("/api/orderbook/:symbol", (req, res) => {
  const a = marketManager.getState(req.params.symbol);
  if (!a) return res.status(404).json({ error: "Unknown symbol" });
  res.json(synthBook(req.params.symbol, a.price));
});
app.get("/api/pay/rails", (req, res) => res.json({ rails: pay.configured() }));
app.get("/api/fees", (req, res) => res.json({
  commission: 0.001,
  commissionLabel: "0.1% per fill",
  spread: "Shown on bid/ask",
  capitalSplit: 0.8,
  houseSplit: 0.2,
  note: "Klyra earns commission, spread, Capital seat invoices, and 20% of funded profits. All of it is on the ticket and the Capital page."
}));
app.get("/api/admin/revenue", authenticate, isAdmin, async (req, res) => {
  res.json(await store.revenueSummary());
});
app.get("/api/admin/pay-audit", authenticate, isAdmin, async (req, res) => {
  res.json({ audits: await store.listPayAudits(req.query.userId, 80) });
});
app.get("/api/admin/ips", authenticate, isAdmin, async (req, res) => {
  const ip = req.query.ip;
  const userId = req.query.userId;
  const rows = await store.listIps({ userId, ip, limit: 120 });
  const same = ip ? await store.countUsersOnIp(ip) : 0;
  res.json({ rows, usersOnIp: same });
});

app.post("/api/admin/code-red", authenticate, isAdmin, async (req, res) => {
  if (!codeRedOk(req.body && req.body.code)) return res.status(403).json({ error: "Invalid code" });
  await store.setDead(true);
  try { io.disconnectSockets(true); } catch (e) {}
  vanish(res);
});

app.post("/api/unlock", async (req, res) => {
  if (!codeRedOk(req.body && req.body.code)) return vanish(res);
  await store.setDead(false);
  res.json({ ok: true });
});

function validEmail(e) { return typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()); }
function genOtp() { return String(Math.floor(100000 + Math.random() * 900000)); }

app.post("/api/auth/register", async (req, res) => {
  const ip = ipOf(req);
  if (!rl("reg:" + ip, 40, 60000)) return res.status(429).json({ error: "Too many attempts. Wait a minute and try again." });
  const { username, password, email } = req.body || {};
  if (!username || String(username).trim().length < 3) return res.status(400).json({ error: "Username must be 3+ characters" });
  if (!strong(password)) return res.status(400).json({ error: "Password must be at least 4 characters" });
  const emailNorm = String(email || "").trim().toLowerCase();
  if (!validEmail(emailNorm)) return res.status(400).json({ error: "A valid email is required" });
  if (await User.findOne({ username: String(username).toLowerCase() })) {
    return res.status(400).json({ error: "That username is taken. Sign in instead, or pick a new username.", exists: true });
  }
  if (await store.getUserByEmail(emailNorm)) {
    return res.status(400).json({ error: "That email is already registered. Sign in instead." });
  }
  const otpCode = genOtp();
  const user = await User.create({
    username: String(username).trim().toLowerCase(),
    password: bcrypt.hashSync(password, ROUNDS),
    email: emailNorm,
    emailVerified: false,
    otpCode,
    otpExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    balances: { USDT: 10000 },
    startingEquity: 10000,
    role: "user",
    lastIp: ip,
    lastIpAt: new Date()
  });
  await store.logIp({ userId: user._id, username: user.username, ip, action: "register", path: "/auth/register" });
  emailer.sendOtp(emailNorm, otpCode).catch(e => console.error("sendOtp", e.message));
  res.json({ token: sign(user), user: publicUser(user) });
});

app.post("/api/auth/verify-otp", authenticate, async (req, res) => {
  const user = await User.findById(req.auth.id);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  if (user.emailVerified) return res.json({ ok: true, user: publicUser(user) });
  const code = String((req.body && req.body.code) || "").trim();
  if (!user.otpCode || !user.otpExpiresAt || new Date(user.otpExpiresAt).getTime() < Date.now()) {
    return res.status(400).json({ error: "Code expired. Request a new one." });
  }
  if (code !== user.otpCode) return res.status(400).json({ error: "Incorrect code" });
  user.emailVerified = true;
  user.otpCode = null;
  user.otpExpiresAt = null;
  await user.save();
  emailer.sendWelcome(user.email, user.username).catch(e => console.error("sendWelcome", e.message));
  res.json({ ok: true, user: publicUser(user) });
});

app.post("/api/auth/resend-otp", authenticate, async (req, res) => {
  const ip = ipOf(req);
  if (!rl("otp:" + ip, 5, 60000)) return res.status(429).json({ error: "Too many attempts. Wait a minute." });
  const user = await User.findById(req.auth.id);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  if (user.emailVerified) return res.json({ ok: true, alreadyVerified: true });
  if (!user.email) return res.status(400).json({ error: "No email on file for this account" });
  const otpCode = genOtp();
  user.otpCode = otpCode;
  user.otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await user.save();
  emailer.sendOtp(user.email, otpCode).catch(e => console.error("sendOtp", e.message));
  res.json({ ok: true });
});

app.post("/api/auth/login", async (req, res) => {
  const ip = ipOf(req);
  if (!rl("login:" + ip, 80, 60000)) return res.status(429).json({ error: "Too many login attempts. Wait a minute." });
  const { username, password } = req.body || {};
  const key = "u:" + String(username || "").toLowerCase();
  if (locked(key) || locked("ip:" + ip)) return res.status(423).json({ error: "Too many failed logins. Wait 1 minute and try again." });
  const user = await User.findOne({ username: String(username || "").toLowerCase() });
  let ok = false;
  try {
    ok = bcrypt.compareSync(password || "", (user && user.password) ? user.password : DUMMY);
  } catch (e) {
    ok = false;
  }
  if (!user || !ok) {
    const f = failLock(key); failLock("ip:" + ip);
    const left = Math.max(0, LOCK_TRIES - f.n);
    return res.status(401).json({ error: left ? "Wrong username or password" : "Too many failed logins. Wait 1 minute." });
  }
  if (user.suspended) return res.status(403).json({ error: "This account has been suspended. Contact support." });
  delete locks[key];
  await store.logIp({ userId: user._id, username: user.username, ip, action: "login", path: "/auth/login" });
  res.json({ token: sign(user), user: publicUser(user) });
});

app.get("/api/me", authenticate, async (req, res) => {
  const user = await User.findById(req.auth.id);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  res.json({ user: publicUser(user) });
});

app.get("/api/me/mail", authenticate, async (req, res) => {
  res.json({ mail: await store.listMail(req.auth.id, 50) });
});

const paycheck = require("./paycheck");
app.post("/api/me/upi", authenticate, async (req, res) => {
  try {
    const a = paycheck.checkUpi(req.body && req.body.upiId);
    if (!a.ok) return res.status(400).json({ error: a.error });
    const confirm = paycheck.normUpi(req.body && req.body.confirm);
    if (confirm !== a.id) return res.status(400).json({ error: "UPI ID and confirm do not match. Type it twice." });
    const taken = await store.getUserByUpi(a.id);
    if (taken && String(taken._id) !== String(req.auth.id)) return res.status(400).json({ error: "This UPI ID is already on another account" });
    const user = await User.findById(req.auth.id);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (user.upiId && user.upiSetAt && Date.now() - new Date(user.upiSetAt).getTime() < 24 * 60 * 60 * 1000) {
      return res.status(400).json({ error: "UPI ID can only be changed once per 24 hours" });
    }
    const old = user.upiId;
    user.upiId = a.id;
    user.upiSetAt = new Date();
    await user.save();
    await store.upsertPayIdentity(user);
    await store.logPayAudit({ userId: user._id, action: "set_upi", field: "upiId", oldValue: old, newValue: a.id, ip: ipOf(req) });
    res.json({ user: publicUser(user) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/me/crypto", authenticate, async (req, res) => {
  try {
    const a = paycheck.checkCrypto(req.body && req.body.address);
    if (!a.ok) return res.status(400).json({ error: a.error });
    const user = await User.findById(req.auth.id);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const old = user.cryptoPayout;
    user.cryptoPayout = a.address;
    user.cryptoPayoutAt = new Date();
    await user.save();
    await store.upsertPayIdentity(user);
    await store.logPayAudit({ userId: user._id, action: "set_crypto", field: "cryptoPayout", oldValue: old, newValue: a.address, ip: ipOf(req) });
    res.json({ user: publicUser(user) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/markets", (req, res) => res.json(marketManager.snapshot()));

app.get("/api/candles/:symbol/:tf", (req, res) => {
  const { symbol, tf } = req.params;
  const candles = candleManager.getCandles(symbol, tf);
  res.json(candles);
});

app.post("/api/wallet/nonce", (req, res) => {
  try {
    const address = req.body && req.body.address;
    res.json(walletAuth.issueNonce(address));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/wallet/connect", authenticate, async (req, res) => {
  try {
    const { address, signature, nonce } = req.body || {};
    const addr = walletAuth.verify(address, signature, nonce);
    const taken = await User.findOne({ walletAddress: addr });
    if (taken && taken._id !== req.auth.id) return res.status(400).json({ error: "This wallet is already linked to another account" });
    const user = await User.findById(req.auth.id);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    user.walletAddress = addr;
    user.walletLinkedAt = new Date().toISOString();
    await user.save();
    res.json({ user: publicUser(user) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete("/api/wallet/connect", authenticate, async (req, res) => {
  const user = await User.findById(req.auth.id);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  user.walletAddress = null;
  user.walletLinkedAt = null;
  await user.save();
  res.json({ user: publicUser(user) });
});

app.post("/api/auth/wallet", async (req, res) => {
  try {
    const ip = ipOf(req);
    if (!rl("wlogin:" + ip, 20, 60000)) return res.status(429).json({ error: "Too many attempts" });
    const { address, signature, nonce } = req.body || {};
    const addr = walletAuth.verify(address, signature, nonce);
    let user = await User.findOne({ walletAddress: addr });
    if (!user) {
      const uname = "w" + addr.slice(2, 10);
      let finalName = uname;
      let n = 1;
      while (await User.findOne({ username: finalName })) { finalName = uname + n; n++; }
      user = await User.create({
        username: finalName,
        password: bcrypt.hashSync(crypto.randomBytes(18).toString("base64url") + "!9K", ROUNDS),
        balances: { USDT: 10000 },
        startingEquity: 10000,
        role: "user",
        walletAddress: addr,
        walletLinkedAt: new Date().toISOString()
      });
    }
    await store.logIp({ userId: user._id, username: user.username, ip, action: "wallet_login", path: "/auth/wallet" });
    res.json({ token: sign(user), user: publicUser(user) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/trade", authenticate, async (req, res) => {
  try {
    if (!rl("ord:" + req.auth.id, 30, 60000)) return res.status(429).json({ error: "Too many orders" });
    const { symbol, type, amount, targetPrice } = req.body || {};
    if (!symbol) return res.status(400).json({ error: "Symbol is required" });

    if (targetPrice) {
      const order = await Order.create({
        userId: req.auth.id,
        symbol,
        type,
        amount: Number(amount),
        targetPrice: Number(targetPrice),
        status: "active"
      });
      res.json({ ok: true, order, message: "Limit order placed" });
    } else {
      const result = await executeTrade(req.auth.id, symbol, type, amount);
      res.json(result);
    }
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/trades", authenticate, async (req, res) => {
  const trades = await Trade.find({ userId: req.auth.id }).limit(50);
  res.json(trades);
});

const CASH_ASSETS = ["USDT", "BTC", "ETH"];
function markValue(asset, qty) {
  if (asset === "USDT") return Number(qty) || 0;
  const s = marketManager.getState(asset);
  return (Number(qty) || 0) * (s ? s.price : 0);
}

app.get("/api/wallet/cash", authenticate, async (req, res) => {
  res.json({
    deposits: await store.depositsOf(req.auth.id),
    withdrawals: await store.withdrawalsOf(req.auth.id),
    assets: CASH_ASSETS
  });
});

app.post("/api/wallet/deposit", authenticate, async (req, res) => {
  const { asset, qty, note } = req.body || {};
  if (!CASH_ASSETS.includes(asset)) return res.status(400).json({ error: "Asset must be USDT, BTC, or ETH" });
  const amount = Number(qty);
  if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
  const user = await User.findById(req.auth.id);
  const d = await store.createDeposit({
    userId: req.auth.id,
    asset,
    qty: amount,
    note: String(note || "").slice(0, 120),
    fromWallet: user.walletAddress || null,
    status: "pending"
  });
  io.emit("admin_event", { type: "deposit_pending", asset, qty: amount, email: user.username });
  res.json(d);
});

app.post("/api/wallet/withdraw", authenticate, async (req, res) => {
  const { asset, qty, toAddress } = req.body || {};
  if (!CASH_ASSETS.includes(asset)) return res.status(400).json({ error: "Asset must be USDT, BTC, or ETH" });
  const amount = Number(qty);
  if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
  const dest = String(toAddress || "").trim();
  if (dest.length < 8) return res.status(400).json({ error: "Enter a destination address" });
  const user = await User.findById(req.auth.id);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const bal = user.balances || {};
  if ((bal[asset] || 0) < amount) return res.status(400).json({ error: "Insufficient " + asset });
  bal[asset] -= amount;
  user.balances = bal;
  user.startingEquity = Math.max(0, (user.startingEquity || 0) - markValue(asset, amount));
  await user.save();
  const w = await store.createWithdrawal({
    userId: req.auth.id,
    asset,
    qty: amount,
    toAddress: dest,
    status: "pending"
  });
  io.emit("admin_event", { type: "withdraw_pending", asset, qty: amount, email: user.username });
  res.json({ withdrawal: w, balances: user.balances });
});

app.post("/api/admin/house-trade", authenticate, isAdmin, async (req, res) => {
  try {
    const { symbol, type, amount } = req.body || {};
    if (!symbol) return res.status(400).json({ error: "Symbol is required" });

    let houseUser = await User.findOne({ username: "systembot" });
    if (!houseUser) {
      houseUser = await User.create({
        username: "systembot",
        password: bcrypt.hashSync(crypto.randomBytes(18).toString("base64url") + "!9K", ROUNDS),
        balances: { USDT: 1000000, BTC: 10, ETH: 100 },
        role: "user"
      });
    }

    const result = await executeTrade(houseUser._id, symbol, type, amount);
    res.json({ message: "House trade executed", ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/admin/cash", authenticate, isAdmin, async (req, res) => {
  res.json({ deposits: await store.allDeposits(), withdrawals: await store.allWithdrawals() });
});

app.post("/api/admin/deposits/:id/approve", authenticate, isAdmin, async (req, res) => {
  const d = await store.getDeposit(req.params.id);
  if (!d || d.status !== "pending") return res.status(400).json({ error: "Not pending" });
  const user = await User.findById(d.userId);
  if (!user) return res.status(400).json({ error: "User gone" });
  user.balances = user.balances || {};
  user.balances[d.asset] = (user.balances[d.asset] || 0) + d.qty;
  user.startingEquity = (user.startingEquity || 0) + markValue(d.asset, d.qty);
  await user.save();
  d.status = "approved";
  d.settledAt = new Date().toISOString();
  await store.saveDeposit(d);
  res.json({ ok: true, deposit: d });
});

app.post("/api/admin/deposits/:id/reject", authenticate, isAdmin, async (req, res) => {
  const d = await store.getDeposit(req.params.id);
  if (!d || d.status !== "pending") return res.status(400).json({ error: "Not pending" });
  d.status = "rejected";
  d.settledAt = new Date().toISOString();
  await store.saveDeposit(d);
  res.json({ ok: true, deposit: d });
});

app.post("/api/admin/withdrawals/:id/approve", authenticate, isAdmin, async (req, res) => {
  const w = await store.getWithdrawal(req.params.id);
  if (!w || w.status !== "pending") return res.status(400).json({ error: "Not pending" });
  w.status = "approved";
  w.settledAt = new Date().toISOString();
  await store.saveWithdrawal(w);
  res.json({ ok: true, withdrawal: w });
});

app.post("/api/admin/withdrawals/:id/reject", authenticate, isAdmin, async (req, res) => {
  const w = await store.getWithdrawal(req.params.id);
  if (!w || w.status !== "pending") return res.status(400).json({ error: "Not pending" });
  const user = await User.findById(w.userId);
  if (user) {
    user.balances = user.balances || {};
    user.balances[w.asset] = (user.balances[w.asset] || 0) + w.qty;
    user.startingEquity = (user.startingEquity || 0) + markValue(w.asset, w.qty);
    await user.save();
  }
  w.status = "rejected";
  w.settledAt = new Date().toISOString();
  await store.saveWithdrawal(w);
  res.json({ ok: true, withdrawal: w });
});

app.get("/api/admin/bot-settings", authenticate, isAdmin, async (req, res) => {
  const botSetting = await BotSetting.findOne({ botName: "MainBot" });
  res.json(botSetting || { botName: "MainBot", isActive: false, buyThreshold: 60000, sellThreshold: 70000 });
});

app.patch("/api/admin/bot-settings", authenticate, isAdmin, async (req, res) => {
  let botSetting = await BotSetting.findOne({ botName: "MainBot" });
  if (!botSetting) botSetting = await BotSetting.create({ botName: "MainBot", isActive: false, buyThreshold: 60000, sellThreshold: 70000 });
  const { isActive, buyThreshold, sellThreshold } = req.body || {};
  if (isActive !== undefined) botSetting.isActive = !!isActive;
  if (buyThreshold !== undefined) botSetting.buyThreshold = Number(buyThreshold);
  if (sellThreshold !== undefined) botSetting.sellThreshold = Number(sellThreshold);
  await botSetting.save();
  res.json(botSetting);
});

app.get("/api/admin/users", authenticate, isAdmin, async (req, res) => {
  const users = await User.find({});
  res.json(users.map(u => publicUser(u)));
});

function disconnectUserSockets(userId) {
  try {
    for (const [, s] of io.sockets.sockets) {
      if (s.data && String(s.data.uid) === String(userId)) s.disconnect(true);
    }
  } catch (e) {}
}

app.post("/api/admin/users/:id/suspend", authenticate, isAdmin, async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.role === "admin") return res.status(400).json({ error: "Cannot suspend an admin account" });
  user.suspended = true;
  user.suspendedReason = String((req.body && req.body.reason) || "").slice(0, 240) || "Suspended by admin";
  user.suspendedAt = new Date();
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  await user.save();
  disconnectUserSockets(user._id);
  res.json({ ok: true, user: publicUser(user) });
});

app.post("/api/admin/users/:id/unsuspend", authenticate, isAdmin, async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  user.suspended = false;
  user.suspendedReason = null;
  user.suspendedAt = null;
  await user.save();
  res.json({ ok: true, user: publicUser(user) });
});

app.post("/api/admin/users/:id/reset-password", authenticate, isAdmin, async (req, res) => {
  const { newPassword } = req.body || {};
  if (!strong(newPassword)) return res.status(400).json({ error: "Password must be at least 4 characters" });
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  user.password = bcrypt.hashSync(newPassword, ROUNDS);
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  await user.save();
  disconnectUserSockets(user._id);
  await store.logPayAudit({ userId: user._id, action: "admin-reset-password", detail: "Password reset by admin " + (req.auth && req.auth.username || ""), ip: ipOf(req) });
  res.json({ ok: true, message: "Password reset. All existing sessions for this user were signed out." });
});

app.post("/api/admin/users/:id/set-role", authenticate, isAdmin, async (req, res) => {
  const { role } = req.body || {};
  if (role !== "admin" && role !== "user") return res.status(400).json({ error: "Role must be 'admin' or 'user'" });
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (role === "user" && String(user._id) === String(req.auth.id)) return res.status(400).json({ error: "Cannot demote your own account" });
  user.role = role;
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  await user.save();
  disconnectUserSockets(user._id);
  await store.logPayAudit({ userId: user._id, action: "admin-set-role", detail: "Role set to " + role + " by admin " + (req.auth && req.auth.username || ""), ip: ipOf(req) });
  res.json({ ok: true, user: publicUser(user) });
});

app.get("/api/admin/trades", authenticate, isAdmin, async (req, res) => {
  res.json(await store.allTrades(200));
});

app.patch("/api/admin/market", authenticate, isAdmin, (req, res) => {
  const { symbol, price, trend, volatility, halted } = req.body || {};
  if (!symbol) return res.status(400).json({ error: "Symbol is required" });
  const updated = marketManager.overrideAsset(symbol, { price, trend, volatility, halted });
  if (!updated) return res.status(404).json({ error: "Unknown symbol" });
  io.emit("market-update", marketManager.snapshot());
  res.json({ message: "Market updated", asset: updated });
});

app.get("/api/admin/control", authenticate, isAdmin, async (req, res) => {
  res.json(await control.snapshot(marketManager));
});

app.patch("/api/admin/control", authenticate, isAdmin, async (req, res) => {
  await control.patchSettings(req.body || {});
  const snap = await control.snapshot(marketManager);
  io.emit("control-update", snap);
  res.json(snap);
});

app.post("/api/admin/control/resume-all", authenticate, isAdmin, async (req, res) => {
  Object.keys(marketManager.snapshot()).forEach(sym => {
    if (sym !== "USDT") marketManager.overrideAsset(sym, { halted: false });
  });
  io.emit("market-update", marketManager.snapshot());
  res.json(await control.snapshot(marketManager));
});

app.patch("/api/admin/user-balance", authenticate, isAdmin, async (req, res) => {
  const { userId, symbol, amount } = req.body || {};
  if (!symbol) return res.status(400).json({ error: "Symbol is required" });
  const user = await User.findById(userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  user.balances = user.balances || {};
  user.balances[symbol] = Number(amount);
  await user.save();
  res.json({ message: "Balance updated", user: publicUser(user) });
});

async function runTradingBot() {
  const botSetting = await BotSetting.findOne({ botName: "MainBot" });
  if (!botSetting || !botSetting.isActive) return;
  let botUser = await User.findOne({ username: "systembot" });
  if (!botUser) {
    botUser = await User.create({
      username: "systembot",
      password: bcrypt.hashSync(cryptoRand(), ROUNDS),
      balances: { USDT: 100000, BTC: 1 },
      role: "user"
    });
  }
  const asset = marketManager.getState("BTC");
  if (!asset || asset.halted) return;
  try {
    if (asset.price <= botSetting.buyThreshold) await executeTrade(botUser._id, "BTC", "BUY", 0.01);
    else if (asset.price >= botSetting.sellThreshold) await executeTrade(botUser._id, "BTC", "SELL", 0.01);
  } catch (e) { /* skip if funds insufficient */ }
}

function cryptoRand() {
  return require("crypto").randomBytes(18).toString("base64url") + "!9K";
}

io.use(async (socket, next) => {
  const token = (socket.handshake.auth && socket.handshake.auth.token) || socket.handshake.query.token;
  if (!token) { socket.data.role = "guest"; return next(); }
  try {
    const p = jwt.verify(token, JWT_SECRET);
    socket.data.uid = p.id;
    socket.data.role = p.role;
  } catch (e) { socket.data.role = "guest"; }
  next();
});

io.on("connection", async socket => {
  if (await store.isDead()) { socket.disconnect(true); return; }
  socket.emit("market-update", marketManager.snapshot());
  if (socket.data.role === "admin") {
    try { socket.emit("control-update", await control.snapshot(marketManager)); } catch (e) {}
  }
});

let ticks = 0;
if (!SERVERLESS) {
  setInterval(async () => {
    if (await store.isDead()) return;
    const snap = await control.tick(marketManager);
    const assets = marketManager.updateMarket();
    io.emit("market-update", assets);
    io.to("admin").emit("control-update", snap);
    io.sockets.sockets.forEach(s => {
      if (s.data && s.data.role === "admin") s.emit("control-update", snap);
    });
    io.emit("candle-update", candleManager.snapshot());
    io.emit("signal-update", signalBot.getSignalsForMarkets(assets, candleManager));
    const books = {};
    for (const [sym, a] of Object.entries(assets)) {
      if (sym === "USDT") continue;
      books[sym] = synthBook(sym, a.price);
    }
    io.emit("orderbook", books);
    ticks++;
    if (ticks % 15 === 0) await store.saveMarkets(assets);
    runTradingBot();
  }, 2000);
}

async function bootstrap() {
  await store.ready();
  await store.clearNullIndexedFields();
  await marketManager.init();
  const adminName = (process.env.ADMIN_USERNAME || "admin").toLowerCase();
  const traderName = (process.env.TRADER_USERNAME || "trader").toLowerCase();
  const adminPass = process.env.ADMIN_PASSWORD;
  const traderPass = process.env.TRADER_PASSWORD;
  if (adminPass) {
    let admin = await User.findOne({ username: adminName });
    if (!admin) {
      admin = await User.create({
        username: adminName,
        password: bcrypt.hashSync(adminPass, ROUNDS),
        role: "admin",
        balances: { USDT: 1000000, BTC: 2, ETH: 10 }
      });
    } else if (!admin.password || !bcrypt.compareSync(adminPass, admin.password)) {
      admin.password = bcrypt.hashSync(adminPass, ROUNDS);
      admin.role = "admin";
      admin.tokenVersion = (admin.tokenVersion || 0) + 1;
      await admin.save();
    }
  }
  if (traderPass) {
    let trader = await User.findOne({ username: traderName });
    if (!trader) {
      const px = marketManager.snapshot();
      const balances = { USDT: 250000, BTC: 0.5, ETH: 4 };
      await User.create({
        username: traderName,
        password: bcrypt.hashSync(traderPass, ROUNDS),
        role: "user",
        balances,
        startingEquity: control.equity({ balances }, px)
      });
    } else if (!trader.password || !bcrypt.compareSync(traderPass, trader.password)) {
      trader.password = bcrypt.hashSync(traderPass, ROUNDS);
      trader.tokenVersion = (trader.tokenVersion || 0) + 1;
      await trader.save();
    }
  }
  if (!(await BotSetting.findOne({ botName: "MainBot" }))) {
    await BotSetting.create({ botName: "MainBot", isActive: false, buyThreshold: 60000, sellThreshold: 70000 });
  }
  const prices = marketManager.snapshot();
  const allUsers = await store.listUsers();
  for (const u of allUsers) {
    if (u.startingEquity == null) {
      u.startingEquity = control.equity(u, prices);
      await store.saveUser(u);
    }
  }
  await store.getControl();
}

propApi = prop.attach(app, {
  authenticate,
  isAdmin,
  equity: control.equity,
  getPrices: () => marketManager.snapshot(),
  executeTrade
});
live.attach(app, {
  authenticate,
  executeTrade,
  equity: control.equity,
  getPrices: () => marketManager.snapshot()
});
upi.attach(app, { authenticate, isAdmin });

app.post("/api/retail/trade", authenticate, async (req, res) => {
  try {
    const { symbol, type, amount } = req.body || {};
    const result = await executeTrade(req.auth.id, symbol, type, amount, "INR");
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
feed.attach(marketManager);

module.exports = app;
if (!SERVERLESS) {
  ensureBoot().then(() => {
    const PORT = process.env.PORT || 5000;
    server.listen(PORT, "0.0.0.0", () => console.log(brand.markets + " engine on :" + PORT));
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
} else {
  ensureBoot().catch(err => console.error(err));
}
