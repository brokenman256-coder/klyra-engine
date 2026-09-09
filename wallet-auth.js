const crypto = require("crypto");
const { verifyMessage, getAddress, isAddress } = require("ethers");

const nonces = new Map();

function norm(addr) {
  try { return getAddress(addr).toLowerCase(); } catch { return String(addr || "").toLowerCase(); }
}

function signMessage(nonce) {
  return [
    "Klyra Markets wants to verify this wallet.",
    "",
    "Signing proves you own the address.",
    "No funds move. No spending approval is requested.",
    "",
    "Nonce: " + nonce
  ].join("\n");
}

function issueNonce(address) {
  if (!isAddress(address)) throw new Error("Invalid wallet address");
  const key = norm(address);
  const nonce = crypto.randomBytes(16).toString("hex");
  nonces.set(key, { nonce, exp: Date.now() + 5 * 60 * 1000 });
  return { address: key, nonce, message: signMessage(nonce) };
}

function verify(address, signature, nonce) {
  if (!isAddress(address)) throw new Error("Invalid wallet address");
  if (!signature || !nonce) throw new Error("Missing signature");
  const key = norm(address);
  const rec = nonces.get(key);
  if (!rec || rec.nonce !== nonce) throw new Error("Nonce expired. Request a new one.");
  if (Date.now() > rec.exp) { nonces.delete(key); throw new Error("Nonce expired. Request a new one."); }
  const msg = signMessage(nonce);
  let recovered;
  try { recovered = verifyMessage(msg, signature); }
  catch (e) { throw new Error("Invalid signature"); }
  if (norm(recovered) !== key) throw new Error("Signature does not match wallet");
  nonces.delete(key);
  return key;
}

module.exports = { issueNonce, verify, norm, isAddress, signMessage };
