// Klyra Capital checkout: unique-amount invoices + public-chain auto-verify.
// Trader pays from Trust Wallet / MetaMask / any wallet. No fake "paymentSuccess".
const https = require("https");
const crypto = require("crypto");
const store = require("./store");

const USDT_TRC20 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_ERC20 = "0xdac17f958d2ee523a2206206994597c13d831ec7";

const CHAINS = {
  usdt_trc20: { asset: "USDT", network: "TRC-20", decimals: 6, label: "USDT · Tron" },
  usdt_erc20: { asset: "USDT", network: "ERC-20", decimals: 6, label: "USDT · Ethereum" },
  eth: { asset: "ETH", network: "Ethereum", decimals: 18, label: "ETH" },
  btc: { asset: "BTC", network: "Bitcoin", decimals: 8, label: "BTC" }
};

function treasury(chain) {
  const map = {
    usdt_trc20: process.env.PAY_USDT_TRC20,
    usdt_erc20: process.env.PAY_USDT_ERC20,
    eth: process.env.PAY_ETH,
    btc: process.env.PAY_BTC
  };
  return String(map[chain] || "").trim();
}

function configured() {
  return Object.keys(CHAINS).map(id => ({
    id,
    live: !!treasury(id),
    address: treasury(id) || null,
    ...CHAINS[id]
  }));
}

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: Object.assign({ "User-Agent": "KlyraPay/1.0" }, headers || {}), timeout: 10000 }, res => {
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

function uniqueCents(seed) {
  const n = crypto.createHash("sha256").update(String(seed)).digest().readUInt16BE(0);
  return (n % 89) + 11; // 11–99 cents, never .00
}

function usdToCrypto(usd, chain, prices) {
  if (chain.startsWith("usdt")) return Number(usd.toFixed(2));
  if (chain === "eth") {
    const px = (prices.ETH && prices.ETH.price) || 3400;
    return Number((usd / px).toFixed(6));
  }
  const px = (prices.BTC && prices.BTC.price) || 64000;
  return Number((usd / px).toFixed(7));
}

function trustUri(chain, address, amount) {
  if (chain === "usdt_trc20") {
    return "https://link.trustwallet.com/send?coin=195&token_id=" + USDT_TRC20 + "&address=" + encodeURIComponent(address) + "&amount=" + amount;
  }
  if (chain === "usdt_erc20") {
    return "https://link.trustwallet.com/send?coin=60&token_id=" + USDT_ERC20 + "&address=" + encodeURIComponent(address) + "&amount=" + amount;
  }
  if (chain === "eth") {
    return "https://link.trustwallet.com/send?coin=60&address=" + encodeURIComponent(address) + "&amount=" + amount;
  }
  return "https://link.trustwallet.com/send?coin=0&address=" + encodeURIComponent(address) + "&amount=" + amount;
}

function metamaskUri(chain, address, amount) {
  if (chain === "eth") return "ethereum:" + address + "?value=" + amount;
  if (chain === "usdt_erc20") return "ethereum:" + address;
  return "";
}

function almost(a, b, chain) {
  const tol = chain.startsWith("usdt") ? 0.009 : chain === "eth" ? 0.00004 : 0.0000008;
  return Math.abs(Number(a) - Number(b)) <= tol;
}

async function scanTrc20(address) {
  const url = "https://api.trongrid.io/v1/accounts/" + address + "/transactions/trc20?limit=40&only_to=true&contract_address=" + USDT_TRC20;
  const headers = {};
  if (process.env.TRONGRID_API_KEY) headers["TRON-PRO-API-KEY"] = process.env.TRONGRID_API_KEY;
  const data = await getJson(url, headers);
  return (data && data.data || []).map(tx => ({
    hash: tx.transaction_id,
    from: tx.from,
    amount: Number(tx.value || 0) / 1e6,
    ts: Number(tx.block_timestamp || 0)
  }));
}

async function scanErc20(address) {
  const key = process.env.ETHERSCAN_API_KEY || "";
  const url = "https://api.etherscan.io/api?module=account&action=tokentx&contractaddress=" + USDT_ERC20 + "&address=" + address + "&page=1&offset=40&sort=desc&apikey=" + key;
  const data = await getJson(url);
  const rows = (data && data.result) || [];
  if (!Array.isArray(rows)) return [];
  const dest = address.toLowerCase();
  return rows.filter(tx => String(tx.to || "").toLowerCase() === dest).map(tx => ({
    hash: tx.hash,
    from: tx.from,
    amount: Number(tx.value || 0) / 1e6,
    ts: Number(tx.timeStamp || 0) * 1000
  }));
}

async function scanEth(address) {
  const key = process.env.ETHERSCAN_API_KEY || "";
  const url = "https://api.etherscan.io/api?module=account&action=txlist&address=" + address + "&page=1&offset=40&sort=desc&apikey=" + key;
  const data = await getJson(url);
  const rows = (data && data.result) || [];
  if (!Array.isArray(rows)) return [];
  const dest = address.toLowerCase();
  return rows.filter(tx => String(tx.to || "").toLowerCase() === dest).map(tx => ({
    hash: tx.hash,
    from: tx.from,
    amount: Number(tx.value || 0) / 1e18,
    ts: Number(tx.timeStamp || 0) * 1000
  }));
}

async function scanBtc(address) {
  const data = await getJson("https://blockstream.info/api/address/" + address + "/txs");
  const rows = Array.isArray(data) ? data : [];
  const out = [];
  for (const tx of rows) {
    let amt = 0;
    for (const v of (tx.vout || [])) {
      if (v.scriptpubkey_address === address) amt += Number(v.value || 0) / 1e8;
    }
    if (amt > 0) out.push({ hash: tx.txid, from: "", amount: amt, ts: (tx.status && tx.status.block_time ? tx.status.block_time * 1000 : Date.now()) });
  }
  return out;
}

async function scan(chain, address) {
  if (chain === "usdt_trc20") return scanTrc20(address);
  if (chain === "usdt_erc20") return scanErc20(address);
  if (chain === "eth") return scanEth(address);
  if (chain === "btc") return scanBtc(address);
  return [];
}

async function createInvoice({ userId, username, tier, usd, chain, prices, ref }) {
  if (!CHAINS[chain]) throw new Error("Unsupported chain");
  const address = treasury(chain);
  if (!address) throw new Error("That rail is not live yet. Pick another coin or wait for treasury setup.");
  const cents = uniqueCents(userId + ":" + tier + ":" + Date.now());
  const usdUnique = Number((Number(usd) + cents / 100).toFixed(2));
  const amount = usdToCrypto(usdUnique, chain, prices || {});
  const now = Date.now();
  const inv = await store.createInvoice({
    userId: String(userId),
    username,
    tier,
    chain,
    asset: CHAINS[chain].asset,
    network: CHAINS[chain].network,
    address,
    amount,
    usd: usdUnique,
    status: "pending",
    ref: ref || "",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 45 * 60 * 1000).toISOString()
  });
  return publicInvoice(inv);
}

function publicInvoice(inv) {
  if (!inv) return null;
  return {
    id: inv.id,
    tier: inv.tier,
    chain: inv.chain,
    asset: inv.asset,
    network: inv.network,
    address: inv.address,
    amount: inv.amount,
    usd: inv.usd,
    status: inv.status,
    txHash: inv.txHash || null,
    expiresAt: inv.expiresAt,
    createdAt: inv.createdAt,
    trustUri: trustUri(inv.chain, inv.address, inv.amount),
    metamaskUri: metamaskUri(inv.chain, inv.address, inv.amount),
    qr: "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" + encodeURIComponent(inv.address),
    label: (CHAINS[inv.chain] || {}).label
  };
}

async function matchInvoice(inv) {
  if (!inv || inv.status !== "pending") return inv;
  if (Date.now() > Date.parse(inv.expiresAt)) {
    inv.status = "expired";
    return await store.saveInvoice(inv);
  }
  if (process.env.PAY_DEV_AUTO === "1") {
    inv.status = "confirmed";
    inv.txHash = "dev_" + inv.id;
    inv.confirmedAt = new Date().toISOString();
    return await store.saveInvoice(inv);
  }
  let txs = [];
  try { txs = await scan(inv.chain, inv.address); } catch (e) { return inv; }
  const used = await store.usedInvoiceHashes();
  const hit = txs.find(tx => tx.hash && !used.has(tx.hash) && almost(tx.amount, inv.amount, inv.chain) && tx.ts >= Date.parse(inv.createdAt) - 60000);
  if (!hit) return inv;
  try {
    await store.registerUtr({ utr: hit.hash, source: "crypto_invoice", refId: inv.id, userId: inv.userId, amount: inv.usd || inv.amount });
  } catch (e) {
    return inv;
  }
  inv.status = "confirmed";
  inv.txHash = hit.hash;
  inv.fromAddress = hit.from;
  inv.confirmedAt = new Date().toISOString();
  await store.logPayAudit({ userId: inv.userId, action: "crypto_paid", field: "txHash", newValue: hit.hash, detail: inv.chain + " " + inv.amount });
  return await store.saveInvoice(inv);
}

async function pollPending() {
  const list = await store.listPendingInvoices();
  for (const inv of list) {
    try { await matchInvoice(inv); } catch (e) {}
  }
}

function attachPoller() {
  setInterval(() => { pollPending().catch(() => {}); }, 12000);
}

module.exports = {
  CHAINS, configured, createInvoice, publicInvoice, matchInvoice, attachPoller, treasury
};
