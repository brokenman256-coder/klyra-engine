// Management profit guard: mark-to-market house P&L and steer graphs so the book stays green.
const store = require("./store");

function equity(user, prices) {
  let v = 0;
  const bal = user.balances || {};
  for (const [k, qty] of Object.entries(bal)) {
    const q = Number(qty) || 0;
    if (k === "USDT") v += q;
    else v += q * (prices[k] ? prices[k].price : 0);
  }
  return v;
}

function isBookUser(u) {
  return u && u.role !== "admin" && u.username !== "systembot";
}

async function snapshot(marketManager) {
  const prices = marketManager.snapshot();
  const users = (await store.listUsers()).filter(isBookUser);
  let userEquity = 0;
  let startEq = 0;
  const exposure = {};
  const leaderboard = [];
  users.forEach(u => {
    if (u.startingEquity == null) {
      u.startingEquity = equity(u, prices);
      store.saveUser(u).catch(e => console.error("snapshot: saveUser failed", e));
    }
    const eq = equity(u, prices);
    const pnl = eq - u.startingEquity;
    userEquity += eq;
    startEq += u.startingEquity;
    leaderboard.push({
      _id: u._id,
      username: u.username,
      equity: eq,
      pnl,
      startingEquity: u.startingEquity,
      balances: Object.assign({}, u.balances || {})
    });
    Object.entries(u.balances || {}).forEach(([k, qty]) => {
      if (k === "USDT") return;
      exposure[k] = (exposure[k] || 0) + (Number(qty) || 0);
    });
  });
  const allTrades = await store.allTrades(1000);
  const fees = allTrades.reduce((s, t) => s + (Number(t.fee) || Number(t.total) * 0.001 || 0), 0);
  const userPnl = userEquity - startEq;
  const housePnl = -userPnl;
  const settings = await store.getControl();
  return {
    housePnl,
    userPnl,
    fees,
    userEquity,
    startEq,
    userCount: users.length,
    exposure,
    leaderboard: leaderboard.sort((a, b) => b.pnl - a.pnl),
    status: housePnl >= (settings.targetHousePnl || 0) ? "profit" : "loss",
    inDrawdown: housePnl < (settings.minHousePnl || 0),
    prices,
    settings: {
      autoProfit: !!settings.autoProfit,
      targetHousePnl: Number(settings.targetHousePnl) || 0,
      minHousePnl: Number(settings.minHousePnl) || -2500,
      aggressiveness: Number(settings.aggressiveness) || 0.65,
      maxMovePctPerTick: Number(settings.maxMovePctPerTick) || 0.0035,
      protectMode: settings.protectMode || "both"
    },
    lastActions: settings.lastActions || [],
    pnlHistory: settings.pnlHistory || [],
    ts: Date.now()
  };
}

async function tick(marketManager) {
  const snap = await snapshot(marketManager);
  const s = snap.settings;
  const actions = [];
  const bias = {};

  if (s.autoProfit) {
    const behind = snap.housePnl < s.targetHousePnl;
    const danger = snap.housePnl < s.minHousePnl;
    if (behind || danger) {
      const heat = Math.min(1, Math.max(0.15, (s.targetHousePnl - snap.housePnl) / Math.max(1000, Math.abs(s.minHousePnl) || 2500)));
      const mag = Math.min(s.maxMovePctPerTick, s.aggressiveness * 0.004 * (danger ? 1.6 : 1) * heat);
      Object.entries(snap.exposure).forEach(([sym, qty]) => {
        if (!qty || Math.abs(qty) < 1e-9) return;
        const asset = marketManager.getState(sym);
        if (!asset) return;
        const fadeLongs = qty > 0;
        const want = fadeLongs ? "bear" : "bull";
        const noise = 0.8 + Math.random() * 0.4; // 80% to 120% of the calculated magnitude
        bias[sym] = (fadeLongs ? -1 : 1) * mag * noise;
        if (asset.trend !== want) {
          asset.trend = want;
          actions.push({ type: "graph-trend", symbol: sym, trend: want, reason: fadeLongs ? "Users net long — fade to protect house" : "Users net short — lift to protect house" });
        }
      });
      if ((s.protectMode === "halt" || s.protectMode === "both") && danger) {
        Object.keys(snap.prices).forEach(sym => {
          if (sym === "USDT") return;
          const asset = marketManager.getState(sym);
          if (asset && !asset.halted) {
            asset.halted = true;
            actions.push({ type: "halt", symbol: sym, reason: "House P&L below floor — trading halted" });
          }
        });
      }
    } else if (snap.housePnl >= s.targetHousePnl) {
      Object.keys(snap.prices).forEach(sym => {
        const asset = marketManager.getState(sym);
        if (asset && asset.trend !== "sideways" && !asset.halted) {
          asset.trend = "sideways";
          actions.push({ type: "graph-trend", symbol: sym, trend: "sideways", reason: "Target met — graphs neutralized" });
        }
      });
    }
  }

  marketManager.setBias(bias);
  if (actions.length) {
    const curC = await store.getControl();
    await store.saveControl({ lastActions: actions.concat(curC.lastActions || []).slice(0, 40) });
  }
  await store.pushPnlPoint({
    t: Date.now(),
    housePnl: snap.housePnl,
    userPnl: snap.userPnl,
    fees: snap.fees,
    userCount: snap.userCount,
    userEquity: snap.userEquity
  });
  const finalC = await store.getControl();
  snap.lastActions = finalC.lastActions || [];
  snap.pnlHistory = finalC.pnlHistory || [];
  snap.bias = bias;
  return snap;
}

async function patchSettings(body) {
  const cur = await store.getControl();
  const next = { ...cur };
  if (body.autoProfit !== undefined) next.autoProfit = !!body.autoProfit;
  if (body.targetHousePnl !== undefined) next.targetHousePnl = Number(body.targetHousePnl);
  if (body.minHousePnl !== undefined) next.minHousePnl = Number(body.minHousePnl);
  if (body.aggressiveness !== undefined) next.aggressiveness = Math.max(0, Math.min(1, Number(body.aggressiveness)));
  if (body.maxMovePctPerTick !== undefined) next.maxMovePctPerTick = Math.max(0, Math.min(0.02, Number(body.maxMovePctPerTick)));
  if (body.protectMode && ["steer", "halt", "both"].includes(body.protectMode)) next.protectMode = body.protectMode;
  return await store.saveControl(next);
}

module.exports = { snapshot, tick, patchSettings, equity };
