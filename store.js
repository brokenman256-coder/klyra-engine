const mongoose = require("mongoose");

const MONGODB_URI = process.env.MONGODB_URI;

// Connection
async function ready() {
  if (!MONGODB_URI) throw new Error("MONGODB_URI missing");
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(MONGODB_URI);
  console.log("store: connected to MongoDB Atlas");
}

// Schemas
const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true, lowercase: true, required: true },
  password: { type: String, required: true },
  role: { type: String, default: "user" },
  balances: { type: Object, default: { USDT: 10000 } },
  startingEquity: Number,
  tokenVersion: { type: Number, default: 0 },
  walletAddress: { type: String, lowercase: true },
  walletLinkedAt: Date,
  upiId: { type: String, lowercase: true, trim: true, sparse: true, unique: true },
  upiSetAt: Date,
  cryptoPayout: { type: String, trim: true, sparse: true, unique: true },
  cryptoPayoutAt: Date,
  propTrialUsed: { type: Boolean, default: false },
  lastIp: String,
  lastIpAt: Date,
  suspended: { type: Boolean, default: false },
  suspendedReason: String,
  suspendedAt: Date,
  email: { type: String, lowercase: true, trim: true, sparse: true, unique: true },
  emailVerified: { type: Boolean, default: false },
  otpCode: String,
  otpExpiresAt: Date,
  createdAt: { type: Date, default: Date.now }
});
UserSchema.index({ lastIp: 1 });
UserSchema.index({ username: 1 }, { unique: true });
UserSchema.index({ upiId: 1 }, { unique: true, sparse: true });
UserSchema.index({ cryptoPayout: 1 }, { unique: true, sparse: true });
UserSchema.index({ walletAddress: 1 }, { unique: true, sparse: true });
UserSchema.index({ email: 1 }, { unique: true, sparse: true });

const TradeSchema = new mongoose.Schema({
  userId: String,
  symbol: String,
  type: String,
  amount: Number,
  price: Number,
  total: Number,
  fee: { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now }
});

const OrderSchema = new mongoose.Schema({
  userId: String,
  symbol: String,
  type: String,
  amount: Number,
  price: Number,
  status: { type: String, default: "active" },
  timestamp: { type: Date, default: Date.now }
});

const BotSchema = new mongoose.Schema({
  botName: { type: String, unique: true },
  isActive: { type: Boolean, default: false },
  buyThreshold: Number,
  sellThreshold: Number
});

const DepositSchema = new mongoose.Schema({
  userId: String,
  asset: String,
  qty: Number,
  note: String,
  status: { type: String, default: "pending" },
  createdAt: { type: Date, default: Date.now }
});

const WithdrawalSchema = new mongoose.Schema({
  userId: String,
  asset: String,
  qty: Number,
  toAddress: String,
  status: { type: String, default: "pending" },
  createdAt: { type: Date, default: Date.now }
});

const ControlSchema = new mongoose.Schema({
  autoProfit: { type: Boolean, default: true },
  targetHousePnl: { type: Number, default: 0 },
  minHousePnl: { type: Number, default: -2500 },
  aggressiveness: { type: Number, default: 0.65 },
  maxMovePctPerTick: { type: Number, default: 0.0035 },
  protectMode: { type: String, default: "both" },
  pnlHistory: [{ t: Date, housePnl: Number, userPnl: Number, fees: Number }],
  lastActions: [String],
  killSwitch: { active: { type: Boolean, default: false }, at: Date }
});

const PropSchema = new mongoose.Schema({
  enabled: { type: Boolean, default: true },
  autoWatch: { type: Boolean, default: true },
  profitSplit: { type: Number, default: 0.8 },
  pricing: { type: Object },
  challenges: [{
    userId: String,
    propUserId: String,
    username: String,
    tier: String,
    initialBalance: Number,
    targetProfit: Number,
    maxDrawdown: Number,
    dailyDrawdown: Number,
    dailyStartBalance: Number,
    currentEquity: Number,
    status: { type: String, default: "active" },
    stage: { type: String, default: "1" },
    isTrial: Boolean,
    profitSplit: Number,
    dayKey: String,
    failReason: String,
    lastChecked: Date,
    createdAt: { type: Date, default: Date.now }
  }],
  referrals: [{
    userId: String,
    commissionEarned: { type: Number, default: 0 }
  }],
  payouts: [{
    userId: String,
    username: String,
    challengeId: String,
    qty: Number,
    status: { type: String, default: "pending" },
    settledAt: Date,
    createdAt: { type: Date, default: Date.now }
  }]
});

const MarketSchema = new mongoose.Schema({
  symbol: { type: String, unique: true },
  price: Number,
  trend: String,
  volatility: Number,
  high: Number,
  low: Number,
  halted: Boolean
});

const RevenueSchema = new mongoose.Schema({
  type: String, // challenge | fee | spread | split
  amount: Number,
  userId: String,
  username: String,
  ref: String,
  note: String,
  createdAt: { type: Date, default: Date.now }
});

const InvoiceSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  userId: String,
  username: String,
  tier: String,
  chain: String,
  asset: String,
  network: String,
  address: String,
  amount: Number,
  usd: Number,
  status: { type: String, default: "pending" },
  txHash: { type: String, sparse: true, unique: true },
  fromAddress: String,
  ref: String,
  createdAt: String,
  expiresAt: String,
  confirmedAt: String,
  bookedRevenue: { type: Boolean, default: false },
  challengeId: String
});

const User = mongoose.model("User", UserSchema);
const Trade = mongoose.model("Trade", TradeSchema);
const Order = mongoose.model("Order", OrderSchema);
const BotSetting = mongoose.model("BotSetting", BotSchema);
const Deposit = mongoose.model("Deposit", DepositSchema);
const Withdrawal = mongoose.model("Withdrawal", WithdrawalSchema);
const Control = mongoose.model("Control", ControlSchema);
const Prop = mongoose.model("Prop", PropSchema);
const Market = mongoose.model("Market", MarketSchema);
const Invoice = mongoose.model("Invoice", InvoiceSchema);
const Revenue = mongoose.model("Revenue", RevenueSchema);
const P2pMatchSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  depositId: { type: String, index: true },
  withdrawId: { type: String, index: true },
  payerId: { type: String, index: true },
  payeeId: { type: String, index: true },
  amount: { type: Number, required: true },
  payeeUpi: { type: String, lowercase: true, index: true },
  payeeName: String,
  status: { type: String, enum: ["waiting_pay", "waiting_payee", "settled", "expired", "disputed"], default: "waiting_pay", index: true },
  utr: { type: String, uppercase: true, sparse: true },
  createdAt: String,
  expiresAt: String,
  settledAt: String
});
P2pMatchSchema.index({ utr: 1 }, { unique: true, sparse: true });
P2pMatchSchema.index({ payerId: 1, status: 1 });
P2pMatchSchema.index({ payeeId: 1, status: 1 });

const UpiOrderSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  userId: { type: String, required: true, index: true },
  amount: { type: Number, required: true },
  status: { type: String, default: "pending", index: true },
  kind: { type: String, enum: ["deposit", "withdraw"], default: "deposit", index: true },
  upiId: { type: String, lowercase: true, index: true },
  matchId: { type: String, index: true },
  utr: { type: String, uppercase: true, sparse: true },
  createdAt: String,
  expiresAt: String,
  settledAt: String
});
UpiOrderSchema.index({ utr: 1 }, { unique: true, sparse: true });
UpiOrderSchema.index({ kind: 1, status: 1, matchId: 1 });
UpiOrderSchema.index({ userId: 1, createdAt: -1 });

const UtrLedgerSchema = new mongoose.Schema({
  utr: { type: String, required: true, unique: true, uppercase: true, trim: true },
  source: { type: String, enum: ["upi_order", "p2p", "crypto_invoice"], required: true },
  refId: { type: String, required: true, index: true },
  userId: { type: String, index: true },
  amount: Number,
  createdAt: { type: Date, default: Date.now }
});

const PayIdentitySchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  username: { type: String, index: true },
  upiId: { type: String, lowercase: true, sparse: true, unique: true },
  cryptoPayout: { type: String, sparse: true, unique: true },
  walletAddress: { type: String, lowercase: true, sparse: true, unique: true },
  upiSetAt: Date,
  cryptoPayoutAt: Date,
  updatedAt: { type: Date, default: Date.now }
});

const PayAuditSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  action: { type: String, required: true, index: true },
  field: String,
  oldValue: String,
  newValue: String,
  ip: String,
  detail: String,
  createdAt: { type: Date, default: Date.now }
});
PayAuditSchema.index({ userId: 1, createdAt: -1 });
PayAuditSchema.index({ action: 1, createdAt: -1 });

const P2pMatch = mongoose.model("P2pMatch", P2pMatchSchema);
const UpiOrder = mongoose.model("UpiOrder", UpiOrderSchema);
const UtrLedger = mongoose.model("UtrLedger", UtrLedgerSchema);
const PayIdentity = mongoose.model("PayIdentity", PayIdentitySchema);
const PayAudit = mongoose.model("PayAudit", PayAuditSchema);

const IpLogSchema = new mongoose.Schema({
  userId: { type: String, index: true },
  username: String,
  ip: { type: String, required: true, index: true },
  action: { type: String, required: true, index: true },
  path: String,
  createdAt: { type: Date, default: Date.now }
});
IpLogSchema.index({ ip: 1, createdAt: -1 });
IpLogSchema.index({ userId: 1, createdAt: -1 });
const IpLog = mongoose.model("IpLog", IpLogSchema);

const MailLogSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  subject: { type: String, required: true },
  html: { type: String, required: true },
  kind: String,
  createdAt: { type: Date, default: Date.now }
});
MailLogSchema.index({ userId: 1, createdAt: -1 });
const MailLog = mongoose.model("MailLog", MailLogSchema);

mongoose.connection.once("open", () => {
  Promise.all([
    User.syncIndexes(),
    UpiOrder.syncIndexes(),
    P2pMatch.syncIndexes(),
    UtrLedger.syncIndexes(),
    PayIdentity.syncIndexes(),
    Invoice.syncIndexes()
  ]).then(() => console.log("store: payment indexes ready")).catch(e => console.error("store: index", e.message));
});

const id = () => new mongoose.Types.ObjectId().toHexString();

async function getUserByUsername(username) {
  return await User.findOne({ username: String(username || "").toLowerCase() });
}
async function getUserByEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  return await User.findOne({ email: e });
}
async function getUserById(uid) {
  return await User.findById(uid);
}
async function getUserByUpi(upiId) {
  const a = String(upiId || "").toLowerCase();
  if (!a) return null;
  const idn = await PayIdentity.findOne({ upiId: a });
  if (idn) return await User.findById(idn.userId);
  return await User.findOne({ upiId: a });
}

async function logPayAudit(doc) {
  await PayAudit.create({
    userId: String(doc.userId || ""),
    action: doc.action || "update",
    field: doc.field || "",
    oldValue: doc.oldValue ? String(doc.oldValue) : "",
    newValue: doc.newValue ? String(doc.newValue) : "",
    ip: doc.ip || "",
    detail: String(doc.detail || "").slice(0, 240)
  });
}

async function upsertPayIdentity(user) {
  if (!user || !user._id) return null;
  const row = {
    userId: String(user._id),
    username: user.username,
    upiId: user.upiId || undefined,
    cryptoPayout: user.cryptoPayout || undefined,
    walletAddress: user.walletAddress || undefined,
    upiSetAt: user.upiSetAt,
    cryptoPayoutAt: user.cryptoPayoutAt,
    updatedAt: new Date()
  };
  await PayIdentity.findOneAndUpdate({ userId: String(user._id) }, row, { upsert: true });
  return row;
}

async function utrTaken(utr) {
  const u = String(utr || "").toUpperCase().trim();
  if (!u) return false;
  const hit = await UtrLedger.findOne({ utr: u });
  if (hit) return true;
  const o = await UpiOrder.findOne({ utr: u });
  const m = await P2pMatch.findOne({ utr: u });
  const inv = await Invoice.findOne({ txHash: u });
  return !!(o || m || inv);
}

async function registerUtr({ utr, source, refId, userId, amount }) {
  const u = String(utr || "").toUpperCase().trim();
  if (!u) throw new Error("UTR required");
  if (await utrTaken(u)) throw new Error("This UTR / tx hash was already used");
  await UtrLedger.create({ utr: u, source, refId: String(refId), userId: String(userId || ""), amount: Number(amount) || 0 });
  return u;
}

async function listPayAudits(userId, limit) {
  const q = userId ? { userId: String(userId) } : {};
  return await PayAudit.find(q).sort({ createdAt: -1 }).limit(limit || 50).lean();
}

async function logIp({ userId, username, ip, action, path }) {
  const addr = String(ip || "").slice(0, 80);
  if (!addr) return;
  await IpLog.create({
    userId: userId ? String(userId) : "",
    username: username || "",
    ip: addr,
    action: String(action || "hit").slice(0, 40),
    path: String(path || "").slice(0, 120)
  });
  if (userId) {
    await User.findByIdAndUpdate(userId, { lastIp: addr, lastIpAt: new Date() });
  }
}

async function logMail({ userId, subject, html, kind }) {
  if (!userId) return;
  await MailLog.create({ userId: String(userId), subject: String(subject || "").slice(0, 200), html: String(html || ""), kind: kind || "" });
}
async function listMail(userId, limit) {
  return await MailLog.find({ userId: String(userId) }).sort({ createdAt: -1 }).limit(limit || 50).lean();
}

async function listIps({ userId, ip, limit }) {
  const q = {};
  if (userId) q.userId = String(userId);
  if (ip) q.ip = String(ip);
  return await IpLog.find(q).sort({ createdAt: -1 }).limit(limit || 100).lean();
}

async function countUsersOnIp(ip) {
  if (!ip) return 0;
  return await User.countDocuments({ lastIp: String(ip) });
}
async function getUserByWallet(address) {
  const a = String(address || "").toLowerCase();
  if (!a) return null;
  return await User.findOne({ walletAddress: a });
}
async function listUsers() {
  return await User.find().lean();
}
async function createUser(u) {
  const user = new User({
    ...u,
    username: String(u.username).toLowerCase(),
    balances: u.balances || { USDT: 10000 }
  });
  await user.save();
  return user;
}
async function saveUser(u) {
  return await User.findByIdAndUpdate(u._id, u, { new: true });
}

async function createTrade(t) {
  const trade = new Trade(t);
  await trade.save();
  return trade;
}
async function tradesOf(userId, limit) {
  return await Trade.find({ userId }).sort({ timestamp: -1 }).limit(limit || 50).lean();
}
async function allTrades(limit) {
  return await Trade.find().sort({ timestamp: -1 }).limit(limit || 200).lean();
}

async function createOrder(o) {
  const order = new Order(o);
  await order.save();
  return order;
}
async function listActiveOrders() {
  return await Order.find({ status: "active" }).lean();
}
async function getOrderById(oid) {
  return await Order.findById(oid).lean();
}
async function saveOrder(o) {
  return await Order.findByIdAndUpdate(o._id, o, { new: true });
}
async function deleteOrder(oid) {
  const res = await Order.findByIdAndDelete(oid);
  return !!res;
}

async function getBot(name) {
  return await BotSetting.findOne({ botName: name || "MainBot" }).lean();
}
async function createBot(b) {
  const bot = new BotSetting(b);
  await bot.save();
  return bot;
}
async function saveBot(b) {
  return await BotSetting.findByIdAndUpdate(b._id, b, { new: true });
}

async function createDeposit(d) {
  const dep = new Deposit(d);
  await dep.save();
  return dep;
}
async function getDeposit(id2) {
  return await Deposit.findById(id2).lean();
}
async function saveDeposit(d) {
  return await Deposit.findByIdAndUpdate(d._id, d, { new: true });
}
async function depositsOf(uid) {
  return await Deposit.find({ userId: uid }).sort({ createdAt: -1 }).lean();
}
async function allDeposits() {
  const deps = await Deposit.find().sort({ createdAt: -1 }).lean();
  // To avoid async map issues, we'll let the caller handle username resolution or do it here
  return deps;
}

async function createWithdrawal(w) {
  const wit = new Withdrawal(w);
  await wit.save();
  return wit;
}
async function getWithdrawal(id2) {
  return await Withdrawal.findById(id2).lean();
}
async function saveWithdrawal(w) {
  return await Withdrawal.findByIdAndUpdate(w._id, w, { new: true });
}
async function withdrawalsOf(uid) {
  return await Withdrawal.find({ userId: uid }).sort({ createdAt: -1 }).lean();
}
async function allWithdrawals() {
  const wits = await Withdrawal.find().sort({ createdAt: -1 }).lean();
  return wits;
}

async function getMarkets() {
  const m = await Market.find().lean();
  const out = {};
  m.forEach(x => { out[x.symbol] = x; });
  return out;
}
async function saveMarkets(m) {
  for (const [sym, data] of Object.entries(m)) {
    await Market.findOneAndUpdate({ symbol: sym }, data, { upsert: true });
  }
}

async function getControl() {
  let c = await Control.findOne();
  if (!c) {
    c = await Control.create({
      autoProfit: true, targetHousePnl: 0, minHousePnl: -2500,
      aggressiveness: 0.65, maxMovePctPerTick: 0.0035, protectMode: "both",
      pnlHistory: [], lastActions: []
    });
  }
  return c.toObject();
}
async function saveControl(patch) {
  const c = await Control.findOne();
  const updated = await Control.findByIdAndUpdate(c._id, patch, { new: true });
  return updated.toObject();
}
async function pushPnlPoint(pt) {
  const c = await Control.findOne();
  c.pnlHistory.push(pt);
  if (c.pnlHistory.length > 240) c.pnlHistory.shift();
  await c.save();
}

async function isDead() {
  const c = await Control.findOne();
  return !!(c && c.killSwitch && c.killSwitch.active);
}
async function setDead(on) {
  const c = await Control.findOne();
  c.killSwitch = { active: !!on, at: on ? new Date() : null };
  await c.save();
  return c.killSwitch;
}

async function getProp() {
  let p = await Prop.findOne();
  if (!p) {
    p = await Prop.create({
      enabled: true, autoWatch: true, profitSplit: 0.8,
      pricing: { "10k": 19, "50k": 59, "100k": 99 },
      challenges: [], referrals: [], payouts: []
    });
  }
  return p.toObject();
}
async function patchProp(body) {
  const p = await Prop.findOne();
  Object.assign(p, body);
  await p.save();
  return p.toObject();
}
async function listPropChallenges() {
  const p = await Prop.findOne();
  return p.challenges || [];
}
async function getPropChallengeByUser(uid) {
  const p = await Prop.findOne();
  const rows = (p.challenges || []).filter(c => String(c.userId) === String(uid));
  return rows.find(c => c.status === "active" || c.stage === "funded") || rows[rows.length - 1] || null;
}
async function getPropChallengeById(cid) {
  const p = await Prop.findOne();
  return p.challenges.find(c => c.id === cid) || null;
}
async function createPropChallenge(doc) {
  const p = await Prop.findOne();
  const row = { ...doc, id: "ch_" + id() };
  p.challenges.push(row);
  await p.save();
  return row;
}
async function savePropChallenge(c) {
  const p = await Prop.findOne();
  const idx = p.challenges.findIndex(x => x.id === c.id);
  if (idx >= 0) p.challenges[idx] = c;
  await p.save();
  return c;
}
async function getPropReferral(uid) {
  const p = await Prop.findOne();
  const r = p.referrals.find(x => x.userId === uid);
  return r || { userId: uid, commissionEarned: 0 };
}
async function addPropCommission(uid, amount) {
  const p = await Prop.findOne();
  let r = p.referrals.find(x => x.userId === uid);
  if (!r) { r = { userId: uid, commissionEarned: 0 }; p.referrals.push(r); }
  r.commissionEarned = (r.commissionEarned || 0) + (Number(amount) || 0);
  await p.save();
  return r;
}
async function listPropPayouts() {
  const p = await Prop.findOne();
  return p.payouts || [];
}
async function getPropPayout(pid) {
  const p = await Prop.findOne();
  return p.payouts.find(x => x._id === pid) || null;
}
async function createPropPayout(doc) {
  const p = await Prop.findOne();
  const row = { ...doc, _id: id() };
  p.payouts.push(row);
  await p.save();
  return row;
}
async function savePropPayout(pout) {
  const p = await Prop.findOne();
  const idx = p.payouts.findIndex(x => x._id === pout._id);
  if (idx >= 0) p.payouts[idx] = pout;
  await p.save();
  return pout;
}

async function createInvoice(doc) {
  const row = { ...doc, id: doc.id || ("inv_" + id()) };
  await Invoice.create(row);
  return row;
}
async function getInvoice(iid) {
  return await Invoice.findOne({ id: iid }).lean();
}
async function saveInvoice(inv) {
  await Invoice.findOneAndUpdate({ id: inv.id }, inv, { upsert: true });
  return inv;
}
async function listPendingInvoices() {
  return await Invoice.find({ status: "pending" }).lean();
}
async function invoicesOf(uid) {
  return await Invoice.find({ userId: String(uid) }).sort({ createdAt: -1 }).limit(20).lean();
}
async function usedInvoiceHashes() {
  const rows = await Invoice.find({ txHash: { $ne: null } }).select("txHash").lean();
  return new Set(rows.map(r => r.txHash).filter(Boolean));
}

async function recordRevenue(doc) {
  if (!doc || !(Number(doc.amount) > 0)) return null;
  const row = await Revenue.create({
    type: doc.type || "fee",
    amount: Number(doc.amount),
    userId: doc.userId ? String(doc.userId) : "",
    username: doc.username || "",
    ref: doc.ref || "",
    note: String(doc.note || "").slice(0, 160)
  });
  return row.toObject();
}

async function revenueSummary() {
  const rows = await Revenue.find().sort({ createdAt: -1 }).limit(500).lean();
  const byType = { challenge: 0, fee: 0, spread: 0, split: 0 };
  let total = 0;
  for (const r of rows) {
    const n = Number(r.amount) || 0;
    total += n;
    if (byType[r.type] != null) byType[r.type] += n;
  }
  return { total, byType, recent: rows.slice(0, 40) };
}

module.exports = {
  ready,
  id,
  getUserByUsername, getUserByEmail, getUserById, getUserByUpi, getUserByWallet, listUsers, createUser, saveUser,
  logPayAudit, upsertPayIdentity, utrTaken, registerUtr, listPayAudits,
  logIp, listIps, countUsersOnIp,
  logMail, listMail,
  createTrade, tradesOf, allTrades,
  createOrder, listActiveOrders, getOrderById, saveOrder, deleteOrder,
  getBot, createBot, saveBot,
  getMarkets, saveMarkets,
  createDeposit, getDeposit, saveDeposit, depositsOf, allDeposits,
  createWithdrawal, getWithdrawal, saveWithdrawal, withdrawalsOf, allWithdrawals,
  getControl, saveControl, pushPnlPoint,
  isDead, setDead,
  getProp, patchProp, listPropChallenges, getPropChallengeByUser, getPropChallengeById,
  createPropChallenge, savePropChallenge, getPropReferral, addPropCommission,
  listPropPayouts, getPropPayout, createPropPayout, savePropPayout,
  createInvoice, getInvoice, saveInvoice, listPendingInvoices, invoicesOf, usedInvoiceHashes,
  recordRevenue, revenueSummary,
  createUpiOrder: async (doc) => { await UpiOrder.create(doc); return doc; },
  getUpiOrder: async (id) => UpiOrder.findOne({ id }).lean(),
  saveUpiOrder: async (row) => { await UpiOrder.findOneAndUpdate({ id: row.id }, row); return row; },
  listUpiOrders: async () => UpiOrder.find().sort({ createdAt: -1 }).limit(80).lean(),
  listUnmatchedWithdraws: async () => UpiOrder.find({
    kind: "withdraw",
    status: "withdraw_pending",
    $or: [{ matchId: null }, { matchId: "" }, { matchId: { $exists: false } }]
  }).lean(),
  createP2p: async (doc) => { await P2pMatch.create(doc); return doc; },
  getP2p: async (id) => P2pMatch.findOne({ id }).lean(),
  saveP2p: async (row) => { await P2pMatch.findOneAndUpdate({ id: row.id }, row); return row; },
  listP2p: async () => P2pMatch.find().sort({ createdAt: -1 }).limit(80).lean()
};
