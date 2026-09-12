// Klyra Capital desk. Does not touch matching, ticks, or wallet verify.
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const store = require("./store");
const pay = require("./pay");
const brand = require("./brand");
const emailer = require("./email");

const TIERS = {
  "10k": { initial: 10000, target: 1000, maxDrawdown: 1000, dailyDrawdown: 500, label: "Starter" },
  "50k": { initial: 50000, target: 5000, maxDrawdown: 5000, dailyDrawdown: 2500, label: "Professional" },
  "100k": { initial: 100000, target: 10000, maxDrawdown: 10000, dailyDrawdown: 5000, label: "Elite" }
};

// Published rules. Hard on purpose (most evals fail these in the industry). Not hidden.
const RULES = {
  minTradingDays: 5,
  consistency: 0.45,
  notes: [
    "Hit 10% profit target.",
    "Do not lose 10% from starting balance (max drawdown).",
    "Do not lose 5% in a single calendar day (daily drawdown).",
    "Trade on at least 5 different days.",
    "No single day may make more than 45% of total profit (consistency)."
  ]
};

const ROUNDS = {
  1: { round: 1, roundLabel: "Round 1 · Evaluation" },
  2: { round: 2, roundLabel: "Round 2 · Verification" },
  "funded": { round: 3, roundLabel: "Round 3 · Funded" },
  "scaled": { round: 4, roundLabel: "Round 4 · Scaled funded" }
};

function publicChallenge(c) {
  if (!c) return null;
  const roundInfo = ROUNDS[c.stage] || { round: 1, roundLabel: "Round 1 · Evaluation" };
  return {
    id: c.id,
    userId: c.userId,
    username: c.username,
    tier: c.tier,
    label: (TIERS[c.tier] || {}).label || c.tier,
    initialBalance: c.initialBalance,
    targetProfit: c.targetProfit,
    maxDrawdown: c.maxDrawdown,
    dailyDrawdown: c.dailyDrawdown,
    currentEquity: c.currentEquity,
    status: c.status,
    stage: c.stage,
    round: roundInfo.round,
    roundLabel: roundInfo.roundLabel,
    isTrial: !!c.isTrial,
    createdAt: c.createdAt,
    profitSplit: c.profitSplit,
    tradingDays: (c.tradingDays || []).length,
    passHold: c.passHold || null,
    failReason: c.failReason || null
  };
}

async function seedBook(user, usd) {
  user.balances = { USDT: Number(usd) || 0, BTC: 0, ETH: 0 };
  user.startingEquity = Number(usd) || 0;
  await store.saveUser(user);
}

async function ensureDesk(owner, usd) {
  const uname = ("px" + String(owner._id)).replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 18);
  const plainPassword = crypto.randomBytes(18).toString("base64url") + "!9K";
  let u = await store.getUserByUsername(uname);
  if (!u) {
    u = await store.createUser({
      username: uname,
      password: bcrypt.hashSync(plainPassword, 10),
      role: "user",
      balances: { USDT: Number(usd) || 0, BTC: 0, ETH: 0 },
      startingEquity: Number(usd) || 0
    });
  } else {
    u.password = bcrypt.hashSync(plainPassword, 10);
    await seedBook(u, usd);
  }
  return { desk: u, plainPassword };
}

async function emailChallengeCredentials(owner, desk, plainPassword, tier) {
  if (!owner.email) return;
  const cfg = TIERS[tier];
  try {
    const mail = await emailer.sendChallengeCredentials(owner.email, {
      username: desk.username,
      password: plainPassword,
      tierLabel: (cfg && cfg.label) || tier,
      accountSize: (cfg && cfg.initial) || 0
    });
    await store.logMail({ userId: owner._id, subject: mail.subject, html: mail.html, kind: "challenge_credentials" });
  } catch (e) { console.error("sendChallengeCredentials", e.message); }
}

async function redeemInvoiceCoupon(inv) {
  if (!inv.couponCode || inv.couponRedeemed) return;
  try { await store.redeemCoupon(inv.couponCode, inv.userId); } catch (e) {}
  inv.couponRedeemed = true;
}

async function startChallenge(user, tier, isTrial, referrerId) {
  const cfg = TIERS[tier];
  if (!cfg) throw new Error("Unknown tier");
  const prop = await store.getProp();
  if (!prop.enabled) throw new Error("Prop desk is closed");
  const existing = await store.getPropChallengeByUser(user._id);
  if (existing && existing.status === "active") throw new Error("You already have an active challenge");
  if (isTrial && user.propTrialUsed) throw new Error("Trial already used on this account");
  const { desk, plainPassword } = await ensureDesk(user, cfg.initial);
  const row = await store.createPropChallenge({
    userId: user._id,
    propUserId: desk._id,
    username: user.username,
    tier,
    initialBalance: cfg.initial,
    targetProfit: cfg.target,
    maxDrawdown: cfg.maxDrawdown,
    dailyDrawdown: cfg.dailyDrawdown,
    dailyStartBalance: cfg.initial,
    currentEquity: cfg.initial,
    status: "active",
    stage: "1",
    isTrial: !!isTrial,
    profitSplit: prop.profitSplit,
    tradingDays: [],
    bestDayProfit: 0,
    passHold: null,
    dayPnl: {}
  });
  if (isTrial) {
    user.propTrialUsed = true;
    await store.saveUser(user);
  }
  if (referrerId && referrerId !== user._id) await store.addPropCommission(referrerId, ((prop.pricing[tier] || {}).entry || 0) * 0.15);
  emailChallengeCredentials(user, desk, plainPassword, tier).catch(e => console.error("emailChallengeCredentials", e.message));
  return row;
}

async function evaluate(c, equity) {
  if (!c || c.status !== "active") return c;
  const now = Date.now();
  const day = new Date().toISOString().slice(0, 10);
  if (c.dayKey !== day) {
    c.dayKey = day;
    c.dailyStartBalance = equity;
  }
  c.currentEquity = equity;
  c.lastChecked = now;
  if (equity <= c.initialBalance - c.maxDrawdown) {
    c.status = "failed";
    c.failReason = "Max drawdown";
  } else if (equity <= c.dailyStartBalance - c.dailyDrawdown) {
    c.status = "failed";
    c.failReason = "Daily drawdown";
  } else if (equity >= c.initialBalance + c.targetProfit) {
    const days = (c.tradingDays || []).length;
    const profit = equity - c.initialBalance;
    const best = Number(c.bestDayProfit || 0);
    if (days < RULES.minTradingDays) {
      c.passHold = "Need " + RULES.minTradingDays + " trading days (have " + days + ")";
    } else if (profit > 0 && best > profit * RULES.consistency) {
      c.status = "failed";
      c.failReason = "Consistency: best day above " + Math.round(RULES.consistency * 100) + "% of total profit";
      c.locked = true;
    } else {
      c.status = "passed";
      c.passHold = null;
    }
  }
  return await store.savePropChallenge(c);
}

async function watch(getPrices, equityFn) {
  const prop = await store.getProp();
  if (!prop.autoWatch) return;
  const prices = getPrices();
  const challenges = await store.listPropChallenges();
  for (const c of challenges) {
    if (c.status !== "active") continue;
    const desk = await store.getUserById(c.propUserId || c.userId);
    if (!desk) continue;
    await evaluate(c, equityFn(desk, prices));
  }
}

async function guardTrade(req, res, next) {
  const c = await store.getPropChallengeByUser(req.auth && req.auth.id);
  if (c && (c.status === "failed" || c.locked)) {
    return res.status(403).json({ error: "Prop account locked (" + (c.failReason || c.status) + ")" });
  }
  next();
}

const PROP_RL = {};
function rlProp(req, kind, limit) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "x").split(",")[0].trim();
  const uid = (req.auth && req.auth.id) || ip;
  const key = kind + ":" + uid;
  const now = Date.now();
  PROP_RL[key] = (PROP_RL[key] || []).filter(t => now - t < 60000);
  if (PROP_RL[key].length >= limit) return false;
  PROP_RL[key].push(now);
  return true;
}

function attach(app, deps) {
  const { authenticate, isAdmin, equity, getPrices, executeTrade } = deps;

  app.get("/api/prop/public", async (req, res) => {
    const p = await store.getProp();
    const challenges = await store.listPropChallenges();
    const pricing = p.pricing && (p.pricing.get ? Object.fromEntries(p.pricing) : p.pricing);
    res.json({
      brand: brand.capital,
      enabled: !!p.enabled,
      profitSplit: p.profitSplit,
      pricing,
      rails: pay.configured(),
      rules: RULES,
      tiers: Object.entries(TIERS).map(([id, t]) => ({
        id, label: t.label, account: t.initial, target: t.target, maxDrawdown: t.maxDrawdown, dailyDrawdown: t.dailyDrawdown, entry: Number((pricing && pricing[id]) || (pricing && pricing.get && pricing.get(id)) || { "10k": 19, "50k": 59, "100k": 99 }[id] || 0)
      })),
      leaderboard: challenges
        .filter(c => c.status === "active" || c.status === "passed" || c.stage === "funded")
        .sort((a, b) => (b.currentEquity || 0) - (a.currentEquity || 0))
        .slice(0, 10)
        .map(c => ({ username: c.username, equity: c.currentEquity, tier: c.tier, status: c.status, stage: c.stage }))
    });
  });

  app.get("/api/prop/me", authenticate, async (req, res) => {
    const c = await store.getPropChallengeByUser(req.auth.id);
    const ref = await store.getPropReferral(req.auth.id);
    const desk = c && await store.getUserById(c.propUserId);
    res.json({
      challenge: publicChallenge(c),
      referral: ref,
      link: "/capital?ref=" + req.auth.id,
      tradeUrl: "/trade?book=prop",
      balances: desk ? desk.balances : null,
      locked: !!(c && (c.status === "failed" || c.locked))
    });
  });

  app.post("/api/prop/trade", authenticate, async (req, res) => {
    try {
      if (!rlProp(req, "tr", 40)) return res.status(429).json({ error: "Too many orders" });
      const c = await store.getPropChallengeByUser(req.auth.id);
      if (!c || !c.propUserId) return res.status(400).json({ error: "No active prop desk. Open a seat first." });
      if (c.status === "failed" || c.locked) return res.status(403).json({ error: "Prop account locked (" + (c.failReason || c.status) + ")" });
      if (c.status !== "active" && c.stage !== "funded") return res.status(400).json({ error: "Desk is not trading" });
      const { symbol, type, amount } = req.body || {};
      if (!symbol) return res.status(400).json({ error: "Symbol is required" });
      if (type !== "BUY" && type !== "SELL") return res.status(400).json({ error: "Invalid side" });
      const qty = Number(amount);
      if (!qty || qty <= 0 || qty > 100000) return res.status(400).json({ error: "Invalid size" });
      const result = await executeTrade(c.propUserId, symbol, type, amount);
      const desk = await store.getUserById(c.propUserId);
      const day = new Date().toISOString().slice(0, 10);
      c.tradingDays = Array.isArray(c.tradingDays) ? c.tradingDays : [];
      if (!c.tradingDays.includes(day)) c.tradingDays.push(day);
      c.dayPnl = c.dayPnl || {};
      const eqNow = desk ? equity(desk, getPrices()) : c.currentEquity;
      const prevEq = Number(c.currentEquity || c.initialBalance);
      const dayDelta = eqNow - prevEq;
      c.dayPnl[day] = (Number(c.dayPnl[day]) || 0) + dayDelta;
      c.bestDayProfit = Math.max(Number(c.bestDayProfit) || 0, ...Object.values(c.dayPnl).map(Number));
      if (desk) await evaluate(c, eqNow);
      res.json(result);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post("/api/prop/order", authenticate, guardTrade, async (req, res) => {
    try {
      if (!rlProp(req, "ord", 20)) return res.status(429).json({ error: "Too many orders" });
      const c = await store.getPropChallengeByUser(req.auth.id);
      if (!c || !c.propUserId) return res.status(400).json({ error: "No active prop desk. Open a seat first." });
      if (c.status === "failed" || c.locked) return res.status(403).json({ error: "Prop account locked (" + (c.failReason || c.status) + ")" });
      if (c.status !== "active" && c.stage !== "funded") return res.status(400).json({ error: "Desk is not trading" });
      const { symbol, side, kind, triggerPrice, amount } = req.body || {};
      if (!symbol) return res.status(400).json({ error: "Symbol is required" });
      if (side !== "BUY" && side !== "SELL") return res.status(400).json({ error: "Invalid side" });
      if (kind !== "LIMIT" && kind !== "STOP") return res.status(400).json({ error: "Invalid order kind" });
      const trig = Number(triggerPrice);
      if (!trig || trig <= 0) return res.status(400).json({ error: "Invalid trigger price" });
      const qty = Number(amount);
      if (!qty || qty <= 0 || qty > 100000) return res.status(400).json({ error: "Invalid size" });
      const prices = getPrices();
      const asset = prices[symbol];
      if (!asset) return res.status(400).json({ error: "Unknown symbol" });
      // A limit/stop priced on the wrong side of the market would either fill
      // instantly as a disguised market order or never trigger at all —
      // reject rather than let either happen silently.
      if (kind === "LIMIT" && side === "BUY" && trig >= asset.price) return res.status(400).json({ error: "Buy Limit must be below the current price" });
      if (kind === "LIMIT" && side === "SELL" && trig <= asset.price) return res.status(400).json({ error: "Sell Limit must be above the current price" });
      if (kind === "STOP" && side === "BUY" && trig <= asset.price) return res.status(400).json({ error: "Buy Stop must be above the current price" });
      if (kind === "STOP" && side === "SELL" && trig >= asset.price) return res.status(400).json({ error: "Sell Stop must be below the current price" });
      const order = await store.createPropOrder({
        userId: String(req.auth.id), propUserId: c.propUserId, username: c.username,
        symbol, side, kind, triggerPrice: trig, amount: qty
      });
      res.json({ ok: true, order });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get("/api/prop/orders", authenticate, async (req, res) => {
    const rows = await store.listPropOrdersByUser(req.auth.id);
    res.json(rows.filter(o => o.status === "pending").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
  });

  app.post("/api/prop/order/:id/cancel", authenticate, async (req, res) => {
    const o = await store.getPropOrderById(req.params.id);
    if (!o || String(o.userId) !== String(req.auth.id)) return res.status(404).json({ error: "Order not found" });
    if (o.status !== "pending") return res.status(400).json({ error: "Order already " + o.status });
    o.status = "cancelled";
    o.cancelledAt = new Date();
    await store.savePropOrder(o);
    res.json({ ok: true, order: o });
  });

  app.get("/api/prop/trades", authenticate, async (req, res) => {
    const c = await store.getPropChallengeByUser(req.auth.id);
    if (!c || !c.propUserId) return res.json([]);
    res.json(await store.tradesOf(c.propUserId, 50));
  });

  app.post("/api/prop/start", authenticate, async (req, res) => {
    try {
      const user = await store.getUserById(req.auth.id);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const { tier, trial } = req.body || {};
      if (!rlProp(req, "start", 8)) return res.status(429).json({ error: "Too many challenge starts" });
      const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
      await store.logIp({ userId: user._id, username: user.username, ip, action: trial ? "prop_trial" : "prop_start", path: "/prop/start" });
      const row = await startChallenge(user, String(tier || ""), !!trial, req.body && req.body.ref);
      res.json({ ok: true, challenge: publicChallenge(row), balances: user.balances });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post("/api/prop/invoice", authenticate, async (req, res) => {
    try {
      const user = await store.getUserById(req.auth.id);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const { tier, chain } = req.body || {};
      if (!rlProp(req, "inv", 6)) return res.status(429).json({ error: "Too many invoices" });
      const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
      await store.logIp({ userId: user._id, username: user.username, ip, action: "prop_invoice", path: "/prop/invoice" });
      const cfg = TIERS[tier];
      if (!cfg) return res.status(400).json({ error: "Unknown tier" });
      const rail = String(chain || "usdt_trc20");
      if (rail !== "usdt_trc20") return res.status(400).json({ error: "Trust Wallet USDT on Tron only" });
      const p = await store.getProp();
      if (!p.enabled) return res.status(400).json({ error: "Klyra Capital is closed" });
      const existing = await store.getPropChallengeByUser(user._id);
      if (existing && existing.status === "active") return res.status(400).json({ error: "You already have an active seat" });
      const pricing = p.pricing && (p.pricing.get ? Object.fromEntries(p.pricing) : p.pricing);
      let usd = Number((pricing && pricing[tier]) || { "10k": 19, "50k": 59, "100k": 99 }[tier] || 0);
      let couponCode = "";
      const rawCoupon = String((req.body && req.body.coupon) || "").trim().toUpperCase();
      if (rawCoupon) {
        const coupon = await store.getCouponByCode(rawCoupon);
        if (!coupon || !coupon.active) return res.status(400).json({ error: "Invalid or inactive coupon" });
        if (coupon.uses >= coupon.maxUses) return res.status(400).json({ error: "This coupon has already been used up" });
        if ((coupon.usedBy || []).includes(String(user._id))) return res.status(400).json({ error: "You've already used this coupon" });
        usd = Math.max(1, Number((usd - coupon.amountUsd).toFixed(2)));
        couponCode = coupon.code;
      }
      const inv = await pay.createInvoice({
        userId: user._id,
        username: user.username,
        tier,
        usd,
        chain: "usdt_trc20",
        prices: getPrices(),
        ref: req.body && req.body.ref,
        couponCode
      });
      res.json({ ok: true, invoice: inv });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get("/api/prop/invoice/:id", authenticate, async (req, res) => {
    let inv = await store.getInvoice(req.params.id);
    if (!inv || String(inv.userId) !== String(req.auth.id)) return res.status(404).json({ error: "Invoice not found" });
    inv = await pay.matchInvoice(inv);
    if (inv.status === "confirmed" && !inv.challengeId) {
      try {
        const user = await store.getUserById(req.auth.id);
        const row = await startChallenge(user, inv.tier, false, inv.ref);
        inv.challengeId = row.id;
        if (!inv.bookedRevenue && Number(inv.usd) > 0) {
          await store.recordRevenue({ type: "challenge", amount: inv.usd, userId: inv.userId, username: inv.username, ref: inv.tier, note: "Capital seat invoice" });
          inv.bookedRevenue = true;
        }
        await redeemInvoiceCoupon(inv);
        await store.saveInvoice(inv);
        return res.json({ ok: true, invoice: pay.publicInvoice(inv), challenge: publicChallenge(row), tradeUrl: "/trade?book=prop" });
      } catch (e) {
        return res.json({ ok: true, invoice: pay.publicInvoice(inv), error: e.message });
      }
    }
    res.json({ ok: true, invoice: pay.publicInvoice(inv), tradeUrl: inv.status === "confirmed" ? "/trade?book=prop" : null });
  });

  app.post("/api/prop/invoice/:id/check", authenticate, async (req, res) => {
    req.params = req.params || {};
    const inv = await store.getInvoice(req.params.id);
    if (!inv || String(inv.userId) !== String(req.auth.id)) return res.status(404).json({ error: "Invoice not found" });
    const checked = await pay.matchInvoice(inv);
    res.json({ ok: true, invoice: pay.publicInvoice(checked) });
  });

  // Kept for admin/manual override only — never auto-succeeds for traders.
  app.post("/api/prop/purchase", authenticate, async (req, res) => {
    return res.status(402).json({ error: "Pay with crypto on /capital. Invoices auto-verify on-chain." });
  });

  app.post("/api/prop/payout", authenticate, async (req, res) => {
    const c = await store.getPropChallengeByUser(req.auth.id);
    if (!c || (c.stage !== "funded" && c.stage !== "scaled")) return res.status(400).json({ error: "Funded desk only" });
    const user = await store.getUserById(req.auth.id);
    if (!user || !user.cryptoPayout) return res.status(400).json({ error: "Save a Trust Wallet USDT address on your account first" });
    const qty = Number(req.body && req.body.qty);
    if (!qty || qty <= 0) return res.status(400).json({ error: "Invalid amount" });
    const profit = Math.max(0, (c.currentEquity || 0) - c.initialBalance);
    const take = Math.min(qty, profit * (c.profitSplit || 0.8));
    if (take <= 0) return res.status(400).json({ error: "No payable profit" });
    const p = await store.createPropPayout({ userId: user._id, username: user.username, challengeId: c.id, qty: take, status: "pending" });
    res.json({ ok: true, payout: p });
  });

  app.get("/api/admin/prop", authenticate, isAdmin, async (req, res) => {
    const p = await store.getProp();
    res.json({
      enabled: p.enabled,
      autoWatch: p.autoWatch,
      profitSplit: p.profitSplit,
      pricing: p.pricing,
      challenges: (await store.listPropChallenges()).map(publicChallenge),
      payouts: await store.listPropPayouts(),
      pendingInvoices: (await store.listPendingInvoices()).map(pay.publicInvoice)
    });
  });

  app.post("/api/admin/prop/invoice/:id/confirm", authenticate, isAdmin, async (req, res) => {
    const inv = await store.getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ error: "Invoice not found" });
    if (inv.status !== "confirmed") {
      inv.status = "confirmed";
      await store.saveInvoice(inv);
      await store.logPayAudit({ userId: inv.userId, action: "admin_manual_confirm_invoice", field: "invoice", newValue: inv.id, ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || "" });
    }
    try {
      const user = await store.getUserById(inv.userId);
      if (user && !inv.challengeId) {
        const row = await startChallenge(user, inv.tier, false, inv.ref);
        inv.challengeId = row.id;
        if (!inv.bookedRevenue && Number(inv.usd) > 0) {
          await store.recordRevenue({ type: "challenge", amount: inv.usd, userId: inv.userId, username: inv.username, ref: inv.tier, note: "Capital seat invoice (manual confirm)" });
          inv.bookedRevenue = true;
        }
        await redeemInvoiceCoupon(inv);
        await store.saveInvoice(inv);
        return res.json({ ok: true, invoice: pay.publicInvoice(inv), challenge: publicChallenge(row) });
      }
    } catch (e) {
      return res.json({ ok: true, invoice: pay.publicInvoice(inv), error: e.message });
    }
    res.json({ ok: true, invoice: pay.publicInvoice(inv) });
  });

  app.get("/api/admin/coupons", authenticate, isAdmin, async (req, res) => {
    res.json({ coupons: await store.listCoupons() });
  });

  app.post("/api/admin/coupons", authenticate, isAdmin, async (req, res) => {
    const amountUsd = Number(req.body && req.body.amountUsd);
    if (!(amountUsd > 0)) return res.status(400).json({ error: "amountUsd must be a positive number" });
    const maxUses = req.body && req.body.maxUses;
    let code = String((req.body && req.body.code) || "").trim().toUpperCase();
    if (!code) code = "KLYRA-" + crypto.randomBytes(4).toString("hex").toUpperCase();
    if (!/^[A-Z0-9-]{3,32}$/.test(code)) return res.status(400).json({ error: "Code must be 3-32 letters, numbers or hyphens" });
    try {
      const row = await store.createCoupon({ code, amountUsd, maxUses, createdBy: req.auth && req.auth.username });
      res.json({ ok: true, coupon: row });
    } catch (e) {
      res.status(400).json({ error: e.code === 11000 ? "That code already exists" : e.message });
    }
  });

  app.post("/api/admin/coupons/:code/deactivate", authenticate, isAdmin, async (req, res) => {
    const row = await store.setCouponActive(req.params.code, false);
    if (!row) return res.status(404).json({ error: "Coupon not found" });
    res.json({ ok: true, coupon: row });
  });

  app.post("/api/admin/coupons/:code/activate", authenticate, isAdmin, async (req, res) => {
    const row = await store.setCouponActive(req.params.code, true);
    if (!row) return res.status(404).json({ error: "Coupon not found" });
    res.json({ ok: true, coupon: row });
  });

  app.patch("/api/admin/prop", authenticate, isAdmin, async (req, res) => {
    const p = await store.patchProp(req.body || {});
    res.json({ enabled: p.enabled, autoWatch: p.autoWatch, profitSplit: p.profitSplit, pricing: p.pricing });
  });

  app.post("/api/admin/prop/promote", authenticate, isAdmin, async (req, res) => {
    const c = await store.getPropChallengeById(req.body && req.body.id);
    if (!c) return res.status(404).json({ error: "Not found" });
    const desk = await store.getUserById(c.propUserId);
    if (c.stage === "1") {
      c.stage = "2";
      c.status = "active";
      c.locked = false;
      c.failReason = null;
      if (desk) await seedBook(desk, c.initialBalance);
      c.currentEquity = c.initialBalance;
      c.dailyStartBalance = c.initialBalance;
      c.targetProfit = Math.round(c.targetProfit / 2); // Round 2 (verification): easier target
    } else if (c.stage === "2" || c.status === "passed") {
      c.stage = "funded";
      c.status = "active";
      c.targetProfit = 0; // Round 3 (funded): no target, just stay inside drawdown
    } else if (c.stage === "funded") {
      // Round 4 (scaled): consistent funded performance earns a bigger book and a better split
      const scale = 2;
      c.stage = "scaled";
      c.status = "active";
      c.initialBalance = Math.round(c.initialBalance * scale);
      c.currentEquity = c.initialBalance;
      c.dailyStartBalance = c.initialBalance;
      c.maxDrawdown = Math.round(c.maxDrawdown * scale);
      c.dailyDrawdown = Math.round(c.dailyDrawdown * scale);
      c.profitSplit = Math.min(0.9, Number(((c.profitSplit || 0.8) + 0.05).toFixed(2)));
      if (desk) await seedBook(desk, c.initialBalance);
    } else {
      return res.status(400).json({ error: "Already at the top round" });
    }
    await store.savePropChallenge(c);
    res.json({ ok: true, challenge: publicChallenge(c) });
  });

  app.post("/api/admin/prop/fail", authenticate, isAdmin, async (req, res) => {
    const c = await store.getPropChallengeById(req.body && req.body.id);
    if (!c) return res.status(404).json({ error: "Not found" });
    c.status = "failed";
    c.locked = true;
    c.failReason = (req.body && req.body.reason) || "Admin";
    await store.savePropChallenge(c);
    res.json({ ok: true, challenge: publicChallenge(c) });
  });

  app.post("/api/admin/prop/payouts/:id/approve", authenticate, isAdmin, async (req, res) => {
    const p = await store.getPropPayout(req.params.id);
    if (!p || p.status !== "pending") return res.status(400).json({ error: "Not pending" });
    const c = await store.getPropChallengeById(p.challengeId);
    const desk = await store.getUserById(c && c.propUserId);
    if (desk) {
      desk.balances = desk.balances || {};
      desk.balances.USDT = Math.max(0, Number(desk.balances.USDT || 0) - p.qty);
      await store.saveUser(desk);
    }
    p.status = "approved";
    p.settledAt = new Date().toISOString();
    await store.savePropPayout(p);
    const split = Number((c && c.profitSplit) || 0.8);
    if (split > 0 && split < 1) {
      const houseTake = Number(p.qty) * ((1 - split) / split);
      if (houseTake > 0) {
        await store.recordRevenue({ type: "split", amount: houseTake, userId: p.userId, username: p.username, ref: p.challengeId, note: "Funded profit house share" });
      }
    }
    res.json({ ok: true, payout: p });
  });

  app.post("/api/admin/prop/payouts/:id/reject", authenticate, isAdmin, async (req, res) => {
    const p = await store.getPropPayout(req.params.id);
    if (!p || p.status !== "pending") return res.status(400).json({ error: "Not pending" });
    p.status = "rejected";
    p.settledAt = new Date().toISOString();
    await store.savePropPayout(p);
    res.json({ ok: true, payout: p });
  });

  async function checkChallenges() {
    try { await watch(getPrices, equity); } catch (e) {}
  }
  async function matchInvoices() {
    try {
      const pending = await store.listPendingInvoices();
      for (const inv of pending) {
        const checked = await pay.matchInvoice(inv);
        if (checked.status === "confirmed" && !checked.challengeId) {
          const user = await store.getUserById(checked.userId);
          if (!user) continue;
          const row = await startChallenge(user, checked.tier, false, checked.ref);
          checked.challengeId = row.id;
          if (!checked.bookedRevenue && Number(checked.usd) > 0) {
            await store.recordRevenue({ type: "challenge", amount: checked.usd, userId: checked.userId, username: checked.username, ref: checked.tier, note: "Capital seat invoice" });
            checked.bookedRevenue = true;
          }
          await redeemInvoiceCoupon(checked);
          await store.saveInvoice(checked);
        }
      }
    } catch (e) {}
  }

  async function checkPendingOrders() {
    const prices = getPrices();
    let orders;
    try { orders = await store.listPropOrders(); } catch (e) { return; }
    for (const o of orders) {
      if (o.status !== "pending") continue;
      const asset = prices[o.symbol];
      if (!asset) continue;
      const px = asset.price;
      const hit =
        (o.kind === "LIMIT" && o.side === "BUY" && px <= o.triggerPrice) ||
        (o.kind === "LIMIT" && o.side === "SELL" && px >= o.triggerPrice) ||
        (o.kind === "STOP" && o.side === "BUY" && px >= o.triggerPrice) ||
        (o.kind === "STOP" && o.side === "SELL" && px <= o.triggerPrice);
      if (!hit) continue;
      try {
        const c = await store.getPropChallengeByUser(o.userId);
        if (!c || c.propUserId !== o.propUserId || c.status === "failed" || c.locked || (c.status !== "active" && c.stage !== "funded")) {
          o.status = "cancelled";
          o.cancelledAt = new Date();
          o.cancelReason = "Desk no longer trading";
          await store.savePropOrder(o);
          continue;
        }
        await executeTrade(o.propUserId, o.symbol, o.side, o.amount);
        o.status = "filled";
        o.filledAt = new Date();
        await store.savePropOrder(o);
        const desk = await store.getUserById(o.propUserId);
        const day = new Date().toISOString().slice(0, 10);
        c.tradingDays = Array.isArray(c.tradingDays) ? c.tradingDays : [];
        if (!c.tradingDays.includes(day)) c.tradingDays.push(day);
        c.dayPnl = c.dayPnl || {};
        const eqNow = desk ? equity(desk, prices) : c.currentEquity;
        const prevEq = Number(c.currentEquity || c.initialBalance);
        c.dayPnl[day] = (Number(c.dayPnl[day]) || 0) + (eqNow - prevEq);
        c.bestDayProfit = Math.max(Number(c.bestDayProfit) || 0, ...Object.values(c.dayPnl).map(Number));
        if (desk) await evaluate(c, eqNow);
      } catch (e) {
        o.status = "cancelled";
        o.cancelledAt = new Date();
        o.cancelReason = e.message || "Execution failed";
        try { await store.savePropOrder(o); } catch (e2) {}
      }
    }
  }

  // In serverless (Vercel), a setInterval here never gets cleared and each
  // cold-start instance piles on its own copy — more and more background
  // load on MongoDB with every new instance until requests start failing.
  // Only run these as persistent loops on a real long-lived process; on
  // Vercel they're instead driven per-request from index.js's pulse().
  if (!process.env.VERCEL) {
    setInterval(checkChallenges, 4000);
    setInterval(matchInvoices, 12000);
    setInterval(checkPendingOrders, 4000);
  }

  return { checkChallenges, matchInvoices, checkPendingOrders };
}

module.exports = { attach, guardTrade, TIERS };
