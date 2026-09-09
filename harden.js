// HTTP hardening only. Does not touch trading, charts, or Profit Guard.
const SCAN = /(^\/(\.env|wp-admin|wp-login|phpmyadmin|xmlrpc\.php|actuator|server-status|\.git)|\.(php|asp|aspx)$)/i;

function headers(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  res.setHeader("Cache-Control", "no-store");
  if (process.env.NODE_ENV === "production") res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.removeHeader("X-Powered-By");
  next();
}

function blockScanners(req, res, next) {
  const p = req.path || "";
  if (SCAN.test(p)) return res.status(404).json({ error: "Not found" });
  next();
}

const hits = {};
function floodGuard(req, res, next) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "x").split(",")[0].trim();
  const now = Date.now();
  const row = (hits[ip] || []).filter(t => now - t < 10000);
  row.push(now);
  hits[ip] = row;
  if (row.length > 80) return res.status(429).json({ error: "Too many requests" });
  next();
}

function attach(app) {
  app.disable("x-powered-by");
  app.disable("etag");
  app.use(headers);
  app.use(blockScanners);
  app.use("/api", floodGuard);
}

module.exports = { attach };
