const nodemailer = require("nodemailer");
const brand = require("./brand");

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  transporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  return transporter;
}

function wrap(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#05070d;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#05070d;padding:32px 0;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#0e1624;border:1px solid #1c2a40;border-radius:16px;overflow:hidden;">
        <tr><td style="padding:28px 32px 0;">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="width:32px;height:32px;border-radius:9px;background:linear-gradient(145deg,#ffe08a,#b8860b);display:inline-block;text-align:center;line-height:32px;font-weight:900;color:#1a1406;font-size:15px;">K</div>
            <span style="color:#eef3fb;font-weight:800;font-size:18px;vertical-align:middle;">${brand.capital}</span>
          </div>
        </td></tr>
        <tr><td style="padding:24px 32px 8px;">
          <h1 style="color:#eef3fb;font-size:22px;margin:0 0 16px;">${title}</h1>
          <div style="color:#8fa3bd;font-size:14.5px;line-height:1.6;">${bodyHtml}</div>
        </td></tr>
        <tr><td style="padding:24px 32px 28px;border-top:1px solid #1c2a40;margin-top:20px;">
          <p style="color:#5c6d84;font-size:12px;margin:20px 0 0;">© ${new Date().getFullYear()} ${brand.capital}. If you didn't request this, you can safely ignore this email.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
  </body></html>`;
}

function btn(href, label) {
  return `<a href="${href}" style="display:inline-block;margin-top:18px;background:linear-gradient(180deg,#ffe08a,#f0c14b);color:#1a1406;text-decoration:none;font-weight:800;padding:12px 22px;border-radius:10px;">${label}</a>`;
}

async function sendMail({ to, subject, html }) {
  const t = getTransporter();
  if (!t) {
    console.log("[email:dev-mode, GMAIL_USER/GMAIL_APP_PASSWORD not set] to=" + to + " subject=" + subject);
    console.log(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  } else {
    await t.sendMail({ from: `"${brand.capital}" <${process.env.GMAIL_USER}>`, to, subject, html });
  }
  return { subject, html };
}

async function sendOtp(to, code) {
  const html = wrap("Verify your email", `
    <p>Use this code to verify your ${brand.capital} account. It expires in 10 minutes.</p>
    <div style="font-size:32px;font-weight:800;letter-spacing:.3em;color:#f0c14b;margin:18px 0;">${code}</div>
    <p>If you didn't create an account, you can ignore this email.</p>
  `);
  return sendMail({ to, subject: `${code} is your ${brand.capital} verification code`, html });
}

async function sendWelcome(to, { username, userId }) {
  const html = wrap("Welcome to " + brand.capital, `
    <p>Hi ${username},</p>
    <p>Your account is ready. Fund a challenge seat with USDT (TRC-20) whenever you're ready to trade.</p>
    <table cellpadding="8" style="background:#0a1220;border:1px solid #1c2a40;border-radius:10px;margin:14px 0;width:100%;">
      <tr><td style="color:#8fa3bd;">Username</td><td style="color:#eef3fb;font-family:monospace;">${username}</td></tr>
      <tr><td style="color:#8fa3bd;">Account ID</td><td style="color:#eef3fb;font-family:monospace;">${userId}</td></tr>
    </table>
    <p>Keep this email as a reference for your unique account ID.</p>
    ${btn("https://klyra-capital.pages.dev", "Open Klyra Capital")}
  `);
  return sendMail({ to, subject: `Welcome to ${brand.capital} — your account ID`, html });
}

async function sendChallengeCredentials(to, { username, password, tierLabel, accountSize }) {
  const html = wrap("Your Helix Desk trading account", `
    <p>Your payment for the <b>${tierLabel}</b> evaluation ($${Number(accountSize).toLocaleString()}) has been confirmed on-chain.</p>
    <p>A dedicated trading login has been created for this challenge. Use it to sign in on <b>Helix Desk</b> — this is separate from your Klyra Capital account login.</p>
    <table cellpadding="8" style="background:#0a1220;border:1px solid #1c2a40;border-radius:10px;margin:14px 0;width:100%;">
      <tr><td style="color:#8fa3bd;">Username</td><td style="color:#eef3fb;font-family:monospace;">${username}</td></tr>
      <tr><td style="color:#8fa3bd;">Password</td><td style="color:#eef3fb;font-family:monospace;">${password}</td></tr>
    </table>
    <p>For your security, change this password after your first login. Keep this email private — anyone with these details can trade this account.</p>
    ${btn("https://helix-desk.pages.dev", "Enter Helix Desk")}
  `);
  return sendMail({ to, subject: `Your Helix Desk login for ${tierLabel}`, html });
}

async function sendPurchaseConfirmed(to, { tierLabel, entryAmount }) {
  const html = wrap("Payment confirmed", `
    <p>We've received your ${entryAmount} USDT payment for the <b>${tierLabel}</b> challenge seat.</p>
    <p>Your Helix Desk trading credentials are on their way in a separate email.</p>
  `);
  return sendMail({ to, subject: `Payment confirmed — ${tierLabel}`, html });
}

module.exports = { sendMail, sendOtp, sendWelcome, sendChallengeCredentials, sendPurchaseConfirmed };
