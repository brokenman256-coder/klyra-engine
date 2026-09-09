const crypto = require("crypto");
const store = require("./store");
const paycheck = require("./paycheck");

function vpa() { return String(process.env.UPI_VPA || "").trim(); }
function payee() { return String(process.env.UPI_PAYEE || "Fenix Markets").trim(); }

function uniqueInr(base) {
  const cents = (crypto.createHash("sha256").update(String(Date.now()) + Math.random()).digest().readUInt16BE(0) % 89) + 11;
  return Number((Number(base) + cents / 100).toFixed(2));
}

function intent(amount, orderId, pa, pn) {
  const pay = encodeURIComponent(pa || vpa());
  const name = encodeURIComponent(pn || payee());
  const am = encodeURIComponent(String(amount));
  const tn = encodeURIComponent("Fenix " + orderId);
  return "upi://pay?pa=" + pay + "&pn=" + name + "&am=" + am + "&cu=INR&tn=" + tn;
}

function qrOf(uri) {
  return "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" + encodeURIComponent(uri);
}

function publicMatch(m) {
  if (!m) return null;
  const uri = intent(m.amount, m.id, m.payeeUpi, m.payeeName || "Fenix user");
  return {
    id: m.id,
    amount: m.amount,
    vpa: m.payeeUpi,
    payee: m.payeeName || "Fenix trader",
    uri,
    qr: qrOf(uri),
    status: m.status,
    utr: m.utr || null,
    expiresAt: m.expiresAt,
    peer: true,
    note: "Pay this Fenix trader. Same ₹ you want to add. They are withdrawing."
  };
}

async function settleMatch(m) {
  if (!m || m.status === "settled") return m;
  const dep = await store.getUpiOrder(m.depositId);
  const wd = await store.getUpiOrder(m.withdrawId);
  const payer = await store.getUserById(m.payerId);
  if (payer) {
    const bal = Object.assign({}, payer.balances || {});
    bal.INR = (Number(bal.INR) || 0) + Number(m.amount);
    payer.balances = bal;
    await store.saveUser(payer);
  }
  if (dep) { dep.status = "approved"; dep.settledAt = new Date().toISOString(); await store.saveUpiOrder(dep); }
  if (wd) { wd.status = "paid"; wd.settledAt = new Date().toISOString(); await store.saveUpiOrder(wd); }
  m.status = "settled";
  m.settledAt = new Date().toISOString();
  await store.saveP2p(m);
  await store.logPayAudit({ userId: m.payerId, action: "p2p_settled", field: "match", newValue: m.id, detail: "in " + m.amount });
  await store.logPayAudit({ userId: m.payeeId, action: "p2p_paid_out", field: "match", newValue: m.id, detail: "out " + m.amount });
  return m;
}

async function expireMatch(m) {
  if (!m || m.status === "settled" || m.status === "expired") return m;
  const wd = await store.getUpiOrder(m.withdrawId);
  if (wd && wd.status !== "paid") {
    wd.matchId = "";
    wd.status = "withdraw_pending";
    await store.saveUpiOrder(wd);
  }
  const dep = await store.getUpiOrder(m.depositId);
  if (dep) { dep.status = "expired"; await store.saveUpiOrder(dep); }
  m.status = "expired";
  await store.saveP2p(m);
  return m;
}

function attach(app, { authenticate, isAdmin }) {
  app.get("/api/upi/config", (req, res) => {
    res.json({ live: true, p2p: true, house: !!vpa(), payee: payee(), vpa: vpa() ? vpa().replace(/.(?=.{4}@)/g, "•") : null });
  });

  app.post("/api/upi/order", authenticate, async (req, res) => {
    try {
      const me = await store.getUserById(req.auth.id);
      if (!me || !me.upiId) return res.status(400).json({ error: "Save your UPI ID first (Wallet → UPI ID). We only match verified IDs." });
      const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
      await store.logIp({ userId: me._id, username: me.username, ip, action: "upi_deposit", path: "/upi/order" });
      const inr = Number(req.body && req.body.inr);
      if (!inr || inr < 100) return res.status(400).json({ error: "Minimum ₹100" });
      const uid = String(req.auth.id);
      const pool = await store.listUnmatchedWithdraws();
      const peer = (pool || []).find(w => String(w.userId) !== uid && w.upiId && Math.floor(Number(w.amount)) === Math.floor(inr));
      const expiresAt = new Date(Date.now() + 40 * 60 * 1000).toISOString();

      if (peer) {
        const amount = Number(peer.amount);
        const depId = "upi_" + crypto.randomBytes(6).toString("hex");
        const matchId = "p2p_" + crypto.randomBytes(6).toString("hex");
        const payeeUser = await store.getUserById(peer.userId);
        await store.createUpiOrder({
          id: depId, userId: uid, amount, status: "matched", kind: "deposit",
          matchId, createdAt: new Date().toISOString(), expiresAt
        });
        peer.matchId = matchId;
        peer.status = "matched";
        await store.saveUpiOrder(peer);
        const m = await store.createP2p({
          id: matchId, depositId: depId, withdrawId: peer.id,
          payerId: uid, payeeId: String(peer.userId), amount,
          payeeUpi: peer.upiId, payeeName: (payeeUser && payeeUser.username) || "Fenix trader",
          status: "waiting_pay", createdAt: new Date().toISOString(), expiresAt
        });
        return res.json({ ok: true, peer: true, order: publicMatch(m), matchId });
      }

      if (!vpa()) return res.status(400).json({ error: "No peer waiting and house UPI is not set. Try again or set UPI_VPA." });
      const amount = uniqueInr(inr);
      const id = "upi_" + crypto.randomBytes(6).toString("hex");
      const row = await store.createUpiOrder({
        id, userId: uid, amount, status: "pending", kind: "deposit",
        createdAt: new Date().toISOString(), expiresAt
      });
      const uri = intent(amount, id);
      res.json({
        ok: true,
        peer: false,
        order: { id: row.id, amount: row.amount, vpa: vpa(), payee: payee(), uri, qr: qrOf(uri), status: row.status, peer: false }
      });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get("/api/upi/match/:id", authenticate, async (req, res) => {
    let m = await store.getP2p(req.params.id);
    if (!m) return res.status(404).json({ error: "Match not found" });
    const uid = String(req.auth.id);
    if (uid !== String(m.payerId) && uid !== String(m.payeeId) && req.auth.role !== "admin") {
      return res.status(403).json({ error: "Not your match" });
    }
    if (m.status === "waiting_pay" && Date.parse(m.expiresAt) < Date.now()) m = await expireMatch(m);
    res.json({ match: publicMatch(m), role: uid === String(m.payerId) ? "payer" : "payee" });
  });

  app.post("/api/upi/match/:id/utr", authenticate, async (req, res) => {
    const m = await store.getP2p(req.params.id);
    if (!m || String(m.payerId) !== String(req.auth.id)) return res.status(404).json({ error: "Not found" });
    if (m.status !== "waiting_pay" && m.status !== "waiting_payee") return res.status(400).json({ error: "Match closed" });
    const chk = paycheck.checkUtr(req.body && req.body.utr);
    if (!chk.ok) return res.status(400).json({ error: chk.error });
    try { await store.registerUtr({ utr: chk.utr, source: "p2p", refId: m.id, userId: req.auth.id, amount: m.amount }); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    m.utr = chk.utr;
    m.status = "waiting_payee";
    await store.saveP2p(m);
    res.json({ ok: true, match: publicMatch(m) });
  });

  app.post("/api/upi/match/:id/confirm", authenticate, async (req, res) => {
    const m = await store.getP2p(req.params.id);
    if (!m || String(m.payeeId) !== String(req.auth.id)) return res.status(404).json({ error: "Not found" });
    if (m.status !== "waiting_payee" && m.status !== "waiting_pay") return res.status(400).json({ error: "Nothing to confirm yet" });
    await settleMatch(m);
    res.json({ ok: true, match: publicMatch(m) });
  });

  app.get("/api/upi/inbox", authenticate, async (req, res) => {
    const all = await store.listP2p();
    const uid = String(req.auth.id);
    const mine = (all || []).filter(m => String(m.payerId) === uid || String(m.payeeId) === uid);
    res.json({ matches: mine.map(m => ({ ...publicMatch(m), role: String(m.payerId) === uid ? "payer" : "payee" })) });
  });

  app.get("/api/upi/order/:id", authenticate, async (req, res) => {
    const row = await store.getUpiOrder(req.params.id);
    if (!row || String(row.userId) !== String(req.auth.id)) return res.status(404).json({ error: "Not found" });
    res.json({ order: row });
  });

  app.post("/api/upi/order/:id/utr", authenticate, async (req, res) => {
    const row = await store.getUpiOrder(req.params.id);
    if (!row || String(row.userId) !== String(req.auth.id)) return res.status(404).json({ error: "Not found" });
    const chk = paycheck.checkUtr(req.body && req.body.utr);
    if (!chk.ok) return res.status(400).json({ error: chk.error });
    try { await store.registerUtr({ utr: chk.utr, source: "upi_order", refId: row.id, userId: req.auth.id, amount: row.amount }); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    row.utr = chk.utr;
    row.status = "review";
    await store.saveUpiOrder(row);
    res.json({ ok: true, order: row });
  });

  app.get("/api/admin/upi", authenticate, isAdmin, async (req, res) => {
    const orders = await store.listUpiOrders();
    const users = await store.listUsers();
    const map = {};
    (users || []).forEach(u => { map[String(u._id)] = u.username; });
    res.json({
      orders: (orders || []).map(o => ({ ...o, username: map[String(o.userId)] || o.userId })),
      matches: await store.listP2p(),
      vpa: vpa(),
      payee: payee()
    });
  });

  app.post("/api/admin/p2p/:id/settle", authenticate, isAdmin, async (req, res) => {
    const m = await store.getP2p(req.params.id);
    if (!m) return res.status(404).json({ error: "Not found" });
    await settleMatch(m);
    res.json({ ok: true, match: publicMatch(m) });
  });

  app.post("/api/admin/p2p/:id/expire", authenticate, isAdmin, async (req, res) => {
    const m = await store.getP2p(req.params.id);
    if (!m) return res.status(404).json({ error: "Not found" });
    await expireMatch(m);
    res.json({ ok: true, match: publicMatch(m) });
  });

  app.get("/api/upi/mine", authenticate, async (req, res) => {
    const all = await store.listUpiOrders();
    res.json({ orders: (all || []).filter(o => String(o.userId) === String(req.auth.id)).slice(0, 30) });
  });

  app.post("/api/upi/withdraw", authenticate, async (req, res) => {
    const me = await store.getUserById(req.auth.id);
    if (!me || !me.upiId) return res.status(400).json({ error: "Save your UPI ID first. Withdrawals only go to the ID on your account." });
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    await store.logIp({ userId: me._id, username: me.username, ip, action: "upi_withdraw", path: "/upi/withdraw" });
    const typed = paycheck.checkUpi(req.body && req.body.upiId);
    if (!typed.ok) return res.status(400).json({ error: typed.error });
    if (typed.id !== String(me.upiId).toLowerCase()) return res.status(400).json({ error: "UPI ID must match the one saved on your account" });
    const amount = uniqueInr(Number(req.body && req.body.inr));
    const upiId = me.upiId;
    if (!amount || amount < 200) return res.status(400).json({ error: "Minimum withdraw ₹200" });
    const user = await store.getUserById(req.auth.id);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const bal = Object.assign({}, user.balances || {});
    if ((Number(bal.INR) || 0) < amount) return res.status(400).json({ error: "Insufficient INR" });
    bal.INR = Number(bal.INR) - amount;
    user.balances = bal;
    await store.saveUser(user);
    const id = "wd_" + crypto.randomBytes(6).toString("hex");
    const row = await store.createUpiOrder({
      id,
      userId: String(req.auth.id),
      amount,
      status: "withdraw_pending",
      kind: "withdraw",
      upiId,
      createdAt: new Date().toISOString()
    });
    res.json({ ok: true, order: row, balances: bal });
  });

  app.post("/api/admin/upi/:id/reject", authenticate, isAdmin, async (req, res) => {
    const row = await store.getUpiOrder(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    if (row.status === "approved" || row.status === "paid") return res.status(400).json({ error: "Already settled" });
    if (row.kind === "withdraw" && row.status === "withdraw_pending") {
      const user = await store.getUserById(row.userId);
      if (user) {
        const bal = Object.assign({}, user.balances || {});
        bal.INR = (Number(bal.INR) || 0) + Number(row.amount);
        user.balances = bal;
        await store.saveUser(user);
      }
    }
    row.status = "rejected";
    row.settledAt = new Date().toISOString();
    await store.saveUpiOrder(row);
    res.json({ ok: true, order: row });
  });

  app.post("/api/admin/upi/:id/paid", authenticate, isAdmin, async (req, res) => {
    const row = await store.getUpiOrder(req.params.id);
    if (!row || row.kind !== "withdraw" || row.status !== "withdraw_pending") return res.status(400).json({ error: "Not a pending withdraw" });
    row.status = "paid";
    row.settledAt = new Date().toISOString();
    await store.saveUpiOrder(row);
    res.json({ ok: true, order: row });
  });

  app.post("/api/admin/upi/:id/approve", authenticate, isAdmin, async (req, res) => {
    const row = await store.getUpiOrder(req.params.id);
    if (!row || (row.status !== "pending" && row.status !== "review")) return res.status(400).json({ error: "Not pending" });
    const user = await store.getUserById(row.userId);
    if (!user) return res.status(400).json({ error: "User gone" });
    const bal = Object.assign({}, user.balances || {});
    bal.INR = (Number(bal.INR) || 0) + Number(row.amount);
    user.balances = bal;
    await store.saveUser(user);
    row.status = "approved";
    row.settledAt = new Date().toISOString();
    await store.saveUpiOrder(row);
    res.json({ ok: true, order: row });
  });
}

module.exports = { attach };
