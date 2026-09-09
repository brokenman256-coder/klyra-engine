const HANDLES = [
  "okaxis", "okicici", "okhdfcbank", "oksbi", "okyesbank", "paytm", "ybl", "ibl", "axl", "apl",
  "kbl", "pnb", "kotak", "barodampay", "freecharge", "amazonpay", "yapl", "idfcbank", "cub",
  "sbi", "hdfcbank", "icici", "axisbank", "yesbank", "unionbank", "indianbank", "canarabank",
  "federal", "upi", "okbizaxis", "okkotak", "waaxis", "rmhdfcbank", "pingpay", "naviaxis"
];

function normUpi(raw) {
  return String(raw || "").trim().toLowerCase().replace(/\s+/g, "");
}

function checkUpi(raw) {
  const id = normUpi(raw);
  if (id.length < 8 || id.length > 80) return { ok: false, error: "UPI ID too short or too long" };
  if (!/^[a-z0-9._-]+@[a-z0-9]+$/.test(id)) return { ok: false, error: "UPI ID must look like name@okaxis / name@ybl / name@paytm" };
  const handle = id.split("@")[1];
  const name = id.split("@")[0];
  if (name.length < 2) return { ok: false, error: "Name part of UPI ID is too short" };
  if (handle.length < 2) return { ok: false, error: "Bank handle missing" };
  const known = HANDLES.some(h => handle === h || handle.endsWith(h));
  if (!known && handle.length < 3) return { ok: false, error: "Unknown UPI handle. Use @okaxis @ybl @paytm @oksbi etc." };
  return { ok: true, id };
}

function checkUtr(raw) {
  const u = String(raw || "").trim().toUpperCase().replace(/\s+/g, "");
  if (u.length < 10 || u.length > 22) return { ok: false, error: "UTR / UPI Ref must be 10–22 characters (from GPay/PhonePe)" };
  if (!/^[A-Z0-9]+$/.test(u)) return { ok: false, error: "UTR can only be letters and numbers" };
  return { ok: true, utr: u };
}

function checkTron(raw) {
  const a = String(raw || "").trim();
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return { ok: false, error: "Tron USDT address must start with T and be 34 characters" };
  return { ok: true, address: a };
}

function checkEth(raw) {
  const a = String(raw || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(a)) return { ok: false, error: "ETH / USDT ERC-20 address must be 0x + 40 hex chars" };
  return { ok: true, address: a.toLowerCase() };
}

function checkCrypto(raw) {
  const a = String(raw || "").trim();
  if (a.startsWith("T")) return checkTron(a);
  if (a.startsWith("0x") || a.startsWith("0X")) return checkEth(a);
  return { ok: false, error: "Enter a Trust Wallet USDT (Tron T…) or ETH (0x…) address" };
}

module.exports = { checkUpi, checkUtr, checkTron, checkEth, checkCrypto, normUpi };
