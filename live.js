const store = require("./store");
const { TIERS } = require("./prop");

function labelOf(c) {
  if (!c) return "";
  return (TIERS[c.tier] && TIERS[c.tier].label) || c.tier;
}

function asBal(b) {
  if (!b) return {};
  if (typeof b.toObject === "function") return b.toObject();
  if (b instanceof Map) return Object.fromEntries(b);
  return Object.assign({}, b);
}

function pub(c) {
  if (!c) return null;
  return {
    id: c.id,
    tier: c.tier,
    label: labelOf(c),
    stage: c.stage,
    status: c.status,
    equity: c.currentEquity,
    initial: c.initialBalance,
    target: c.targetProfit,
    maxDrawdown: c.maxDrawdown,
    dailyDrawdown: c.dailyDrawdown,
    split: c.profitSplit,
    tradingDays: (c.tradingDays || []).length,
    failReason: c.failReason || null,
    passHold: c.passHold || null,
    locked: !!(c.locked || c.status === "failed")
  };
}

async function deskOf(c) {
  if (!c || !c.propUserId) return { challenge: pub(c), balances: null };
  const desk = await store.getUserById(c.propUserId);
  return { challenge: pub(c), balances: desk ? asBal(desk.balances) : null };
}

function attach(app, { authenticate, executeTrade, equity, getPrices }) {
  app.get("/api/desk/session", authenticate, async (req, res) => {
    const c = await store.getPropChallengeByUser(req.auth.id);
    const user = await store.getUserById(req.auth.id);
    const funded = c && String(c.stage) === "funded" && c.status !== "failed";
    const plasticOn = c && !funded && c.status !== "failed";
    const pack = c ? await deskOf(c) : { challenge: null, balances: null };
    res.json({
      venue: "Helix Desk",
      username: user && user.username,
      plastic: {
        available: !!plasticOn,
        simulated: true,
        title: "Evaluation · plastic capital",
        subtitle: "Not withdrawable. Rules apply.",
        ...pack,
        challenge: plasticOn ? pack.challenge : (c && !funded ? pack.challenge : null)
      },
      live: {
        available: !!funded,
        simulated: false,
        title: "Live · company capital",
        subtitle: "Funded book. Profit share on payout.",
        ...pack,
        challenge: funded ? pack.challenge : null
      }
    });
  });

  app.get("/api/live/me", authenticate, async (req, res) => {
    const c = await store.getPropChallengeByUser(req.auth.id);
    const funded = c && String(c.stage) === "funded" && c.status !== "failed";
    if (!funded) {
      return res.status(403).json({ error: "Live book opens after you pass and get funded.", live: false, plastic: !!(c && c.status === "active") });
    }
    const pack = await deskOf(c);
    res.json({ live: true, venue: "Helix Desk", ...pack, tradeUrl: "/" });
  });

  app.post("/api/live/trade", authenticate, async (req, res) => {
    const c = await store.getPropChallengeByUser(req.auth.id);
    const funded = c && String(c.stage) === "funded" && c.status !== "failed";
    if (!funded) return res.status(403).json({ error: "Live desk is for funded traders only" });
    const { symbol, type, amount } = req.body || {};
    const result = await executeTrade(c.propUserId, symbol, type, amount);
    const desk = await store.getUserById(c.propUserId);
    if (desk) {
      c.currentEquity = equity(desk, getPrices());
      await store.savePropChallenge(c);
    }
    res.json(result);
  });

  app.get("/api/live/trades", authenticate, async (req, res) => {
    const c = await store.getPropChallengeByUser(req.auth.id);
    if (!c || !c.propUserId) return res.json([]);
    res.json(await store.tradesOf(c.propUserId, 50));
  });
}

module.exports = { attach };
