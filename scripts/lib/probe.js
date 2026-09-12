"use strict";
// Twin of forgemesh/site/lib/scan.ts and x402-forgemesh-stuffer/src/handlers/x402scan.js.
// Keep the three in sync when probe semantics change. Differences on purpose:
//  - uses the seller's DECLARED method (and sample body) instead of GET-then-405-retry
//  - checks the header envelope AND the body envelope (both are scored separately)
//  - reports facts only; scoring lives in scripts/lib/rubrics/*.js
const { promises: dns } = require("node:dns");
const net = require("node:net");

const TIMEOUT_MS = 8000;
const MAX_BYTES = 64 * 1024;
const ALLOWED_PORTS = new Set(["80", "443", "8080", "8443"]);
const USER_AGENT = "x402-verified/2.0 (+https://forgemesh.io/partners)";

class ProbeInputError extends Error {}

function isPrivateIp(ip) {
  const low = ip.toLowerCase();
  if (net.isIPv6(low) || low.includes(":")) {
    return (
      low === "::1" || low === "::" || low.startsWith("fe80") || low.startsWith("fc") ||
      low.startsWith("fd") || low.startsWith("::ffff:127.") || low.startsWith("::ffff:10.") ||
      low.startsWith("::ffff:192.168.") || low.startsWith("::ffff:169.254.") ||
      /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(low)
    );
  }
  return (
    /^127\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^169\.254\./.test(ip) ||
    ip === "0.0.0.0" || /^0\./.test(ip)
  );
}

async function validateTarget(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new ProbeInputError(`not a valid URL: ${rawUrl}`); }
  if (u.protocol !== "https:") throw new ProbeInputError("only https URLs are probed");
  const hostname = u.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".internal") || hostname.endsWith(".local")) {
    throw new ProbeInputError("local and internal hostnames are refused");
  }
  const port = u.port || "443";
  if (!ALLOWED_PORTS.has(port)) throw new ProbeInputError(`port ${port} is not probed`);
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new ProbeInputError("private IP refused");
  } else {
    const address = await dns.lookup(hostname).then((r) => r.address).catch(() => null);
    if (!address) throw new ProbeInputError(`DNS resolution failed for ${hostname}`);
    if (isPrivateIp(address)) throw new ProbeInputError("hostname resolves to a private address");
  }
  return u;
}

async function readCapped(res, cap) {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > cap ? buf.subarray(0, cap) : buf;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      chunks.push(Buffer.from(value.subarray(0, value.length - (total - cap))));
      try { await reader.cancel(); } catch { /* best effort */ }
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function doFetch(url, method, body) {
  const res = await fetch(url, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/json, */*",
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
    },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const buf = await readCapped(res, MAX_BYTES);
  return { status: res.status, headers: res.headers, body: buf };
}

function decodeBase64Json(b64) {
  let json;
  try { json = Buffer.from(String(b64), "base64").toString("utf8"); }
  catch (e) { return { data: null, errors: [`payment-required header is not valid base64: ${e.message}`] }; }
  try { return { data: JSON.parse(json), errors: [] }; }
  catch (e) { return { data: null, errors: [`payment-required header decodes but is not valid JSON: ${e.message}`] }; }
}

function validateEnvelope(data) {
  const errors = [];
  const accepts = [];
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    return { valid: false, errors: ["envelope is not a JSON object"], accepts, x402Version: null };
  }
  if (typeof data.x402Version !== "number") errors.push('envelope missing numeric "x402Version" field');
  if (!Array.isArray(data.accepts) || data.accepts.length === 0) {
    errors.push('envelope missing a non-empty "accepts" array');
  } else {
    for (const a of data.accepts) {
      if (!a || typeof a !== "object") { errors.push("accepts[] entry is not an object"); continue; }
      for (const f of ["scheme", "network", "asset", "payTo", "amount"]) {
        if (a[f] == null) errors.push(`accepts[] entry missing "${f}"`);
      }
      accepts.push({
        scheme: a.scheme ?? null,
        network: a.network ?? null,
        asset: a.asset ?? null,
        payTo: a.payTo ?? null,
        amount: a.amount != null ? String(a.amount) : null,
        maxTimeoutSeconds: typeof a.maxTimeoutSeconds === "number" ? a.maxTimeoutSeconds : null,
      });
    }
  }
  return { valid: errors.length === 0, errors, accepts, x402Version: typeof data.x402Version === "number" ? data.x402Version : null };
}

function emptyResult(endpoint, startedAt) {
  return {
    url: endpoint.url,
    method_used: endpoint.method,
    reachable: false,
    http_status: null,
    is_402: false,
    envelope_source: "missing",
    header_envelope: false,
    body_envelope: false,
    envelope_valid: false,
    envelope_errors: [],
    x402_version: null,
    accepts: [],
    mpp_header: false,
    response_time_ms: Date.now() - startedAt,
    error: null,
  };
}

// Probe one declared endpoint. Never throws for network problems; only for refused targets.
async function probeEndpoint(endpoint) {
  const target = await validateTarget(endpoint.url);
  const t0 = Date.now();
  const out = emptyResult({ ...endpoint, url: target.href }, t0);
  let res;
  try {
    res = await doFetch(target.href, endpoint.method, endpoint.body);
  } catch (e) {
    out.error = e.message;
    out.response_time_ms = Date.now() - t0;
    return out;
  }
  out.reachable = true;
  out.response_time_ms = Date.now() - t0;
  out.http_status = res.status;
  out.is_402 = res.status === 402;
  out.mpp_header = /^\s*payment\b/i.test(res.headers.get("www-authenticate") || "");

  // Header envelope (x402 v2 transport).
  const headerRaw = res.headers.get("payment-required");
  let headerEnv = null;
  if (headerRaw) {
    const { data, errors } = decodeBase64Json(headerRaw);
    headerEnv = errors.length ? { valid: false, errors, accepts: [], x402Version: null } : validateEnvelope(data);
    out.header_envelope = true;
  }
  // Body envelope (stock v1 client compatibility). Checked independently of the header.
  let bodyEnv = null;
  const bodyText = res.body.toString("utf8");
  if (bodyText.includes('"x402Version"')) {
    try { bodyEnv = validateEnvelope(JSON.parse(bodyText)); out.body_envelope = true; }
    catch (e) { bodyEnv = { valid: false, errors: [`body contains "x402Version" but is not valid JSON: ${e.message}`], accepts: [], x402Version: null }; out.body_envelope = true; }
  }
  const primary = headerEnv || bodyEnv;
  if (primary) {
    out.envelope_source = headerEnv ? "header" : "body";
    out.envelope_valid = primary.valid;
    out.envelope_errors = primary.errors;
    out.x402_version = primary.x402Version;
    out.accepts = primary.accepts;
    // A body envelope only counts as v1-compatible when it validates on its own.
    if (bodyEnv && !bodyEnv.valid) out.body_envelope = false;
  }
  return out;
}

async function fetchText(url, ms = 4000) {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(ms), cache: "no-store", headers: { "user-agent": USER_AGENT } });
    if (!res.ok) return null;
    const buf = await readCapped(res, MAX_BYTES);
    return buf.toString("utf8");
  } catch { return null; }
}

function normalizeRoute(u) {
  return String(u).replace(/\/+$/, "").toLowerCase();
}

// Discovery facts for a seller: manifest present, manifest names every declared route, llms.txt present.
async function probeDiscovery({ endpoints, manifest, llms_txt }) {
  const origin = new URL(endpoints[0].url).origin;
  const manifestUrl = manifest || `${origin}/.well-known/x402`;
  const llmsUrl = llms_txt || `${origin}/llms.txt`;
  const out = { manifest_url: manifestUrl, manifest_ok: false, manifest_lists_route: false, llms_url: llmsUrl, llms_ok: false };
  const manifestText = await fetchText(manifestUrl);
  if (manifestText) {
    try {
      const parsed = JSON.parse(manifestText);
      out.manifest_ok = parsed != null && typeof parsed === "object" && !Array.isArray(parsed);
    } catch { out.manifest_ok = false; }
    if (out.manifest_ok) {
      const hay = normalizeRoute(manifestText);
      out.manifest_lists_route = endpoints.every((e) => {
        const full = normalizeRoute(e.url);
        const path = normalizeRoute(new URL(e.url).pathname);
        return hay.includes(full) || hay.includes(`"${path}"`) || hay.includes(`"${path}/"`) || hay.includes(path + '"') ;
      });
    }
  }
  const llms = await fetchText(llmsUrl);
  out.llms_ok = typeof llms === "string" && llms.trim().length > 0 && !/^\s*</.test(llms);
  return out;
}

// One probe RUN for a seller = every declared endpoint + discovery, summarized for scoring.
async function probeSeller(seller, { concurrency = 4 } = {}) {
  const at = new Date().toISOString();
  const results = [];
  const queue = seller.endpoints.map((e, i) => ({ ...e, index: i }));
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const ep = queue.shift();
      try { results[ep.index] = await probeEndpoint(ep); }
      catch (e) { results[ep.index] = { ...emptyResult(ep, Date.now()), error: e.message }; }
    }
  });
  await Promise.all(workers);
  const discovery = await probeDiscovery(seller);
  const payTo = seller.payTo.toLowerCase();
  const all = (fn) => results.every(fn);
  const networksDetected = [...new Set(results.flatMap((r) => r.accepts.map((a) => a.network).filter(Boolean)))];
  return {
    at,
    endpoints: results,
    ...discovery,
    is_402: all((r) => r.is_402),
    envelope_valid: all((r) => r.envelope_valid),
    payto_match: all((r) => r.accepts.length > 0 && r.accepts.every((a) => String(a.payTo || "").toLowerCase() === payTo)),
    header_envelope: all((r) => r.header_envelope),
    body_envelope: all((r) => r.body_envelope),
    x402_version_2: all((r) => r.x402_version === 2),
    mpp_header: results.some((r) => r.mpp_header),
    ms: Math.max(...results.map((r) => r.response_time_ms)),
    networks_detected: networksDetected,
    pass: all((r) => r.is_402 && r.envelope_valid),
  };
}

module.exports = { ProbeInputError, validateTarget, probeEndpoint, probeDiscovery, probeSeller, validateEnvelope, USER_AGENT };
