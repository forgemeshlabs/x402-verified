#!/usr/bin/env node
"use strict";
// Unclaimed index: every x402 origin the CDP Bazaar lists, probed and scored on protocol facts
// alone, with no seller input. A row stays "unclaimed" until the seller claims it
// (POST https://router.forgemesh.io/api/verified/claim, $5 USDC on Base) or submits the free PR.
// Unclaimed rows carry no contact, no badge and no proof, so the ceiling is 85/100.
// VPS only (reads the stuffer's Bazaar snapshot DB). Weekly cron plus --slug for one origin.
//   node scripts/unclaimed.js [--slug <slug>] [--limit N] [--no-push] [--concurrency 8]
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DIRS, loadSellers, readJson, writeJsonAtomic, registrableDomain } = require("./lib/sellers");
// Operators see this line in their access logs: the probe doubles as the only notice an
// unclaimed origin ever gets. Set before lib/probe reads it.
process.env.X402_VERIFIED_UA ||= "x402-verified/2.0 (+https://forgemesh.io/claim; your x402 origin is in the ForgeMesh unclaimed index, claim your row)";
const { probeEndpoint, probeDiscovery } = require("./lib/probe");
const { compute } = require("./lib/score");
const { SPEC } = require("./lib/rubrics/x402");
const { commitAndPush } = require("./lib/git");

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const BAZAAR_DB = process.env.BAZAAR_DB || "/home/ubuntu/repos/x402-forgemesh-stuffer/var/bazaar.db";
const SQLITE3 = process.env.SQLITE3_BIN || "sqlite3";
const EXCLUDE_FILE = process.env.UNCLAIMED_EXCLUDE || path.join(DIRS.unclaimed, "_exclude.json");
const STATE_DIR = path.join(DIRS.unclaimed, "state");
const SITE = "https://forgemesh.io";
const CLAIM_URL = "https://router.forgemesh.io/api/verified/claim";
const CLAIM_PRICE_USDC = "5";
const LIST_MIN_SCORE = 70;        // "ready" band and up appear on forgemesh.io/verified
const SNAPSHOT_WINDOW = 3;        // seen in one of the last 3 Bazaar snapshots (3/day)
const MAX_ROUTES_PER_ORIGIN = 3;
const CONCURRENCY = Number(opt("--concurrency") || 8);

function sql(q) {
  return execFileSync(SQLITE3, ["-json", BAZAAR_DB, q], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 60000 }).trim();
}
function originOf(u) { try { return new URL(u).origin; } catch { return null; } }
function slugFor(origin) {
  return new URL(origin).hostname.toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "");
}
function priceUsdc(atomic) { return (Number(atomic) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0"); }

function loadExclude() {
  const base = { wallets: [], domains: [] };
  if (!fs.existsSync(EXCLUDE_FILE)) return base;
  const e = readJson(EXCLUDE_FILE);
  return { wallets: (e.wallets || []).map((w) => w.toLowerCase()), domains: (e.domains || []).map((d) => d.toLowerCase()) };
}

function candidates() {
  const rows = JSON.parse(sql(`select resource, pay_to, network, price_atomic, description from resources
    where last_seen_snapshot >= (select max(id) from snapshots) - ${SNAPSHOT_WINDOW - 1}
      and resource like 'https://%' and network = 'eip155:8453' and price_atomic is not null and cast(price_atomic as integer) > 0`) || "[]");
  const excl = loadExclude();
  const sellers = loadSellers().map((e) => e.data);
  const sellerDomains = new Set(sellers.map((s) => { try { return registrableDomain(new URL(s.homepage).hostname); } catch { return null; } }).filter(Boolean));
  const sellerWallets = new Set(sellers.map((s) => s.payTo.toLowerCase()));
  const byOrigin = new Map();
  for (const r of rows) {
    const origin = originOf(r.resource);
    if (!origin) continue;
    const host = new URL(origin).hostname.toLowerCase();
    const dom = registrableDomain(host);
    if (excl.domains.some((d) => host === d || host.endsWith(`.${d}`))) continue;
    if (sellerDomains.has(dom)) continue;
    const wallet = String(r.pay_to || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(wallet) || excl.wallets.includes(wallet) || sellerWallets.has(wallet)) continue;
    if (!byOrigin.has(origin)) byOrigin.set(origin, { origin, wallets: new Map(), routes: [] });
    const o = byOrigin.get(origin);
    o.wallets.set(wallet, (o.wallets.get(wallet) || 0) + 1);
    o.routes.push({ url: r.resource, price_atomic: String(r.price_atomic), description: r.description || "" });
  }
  const out = [];
  for (const o of byOrigin.values()) {
    // One wallet per record (schema): the wallet most routes on this origin pay to.
    const payTo = [...o.wallets.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const routes = o.routes.sort((a, b) => Number(a.price_atomic) - Number(b.price_atomic) || a.url.length - b.url.length);
    const seen = new Set();
    const picked = [];
    for (const r of routes) {
      const p = new URL(r.url).pathname.split("/").slice(0, 3).join("/");
      if (seen.has(p)) continue;
      seen.add(p); picked.push(r);
      if (picked.length >= MAX_ROUTES_PER_ORIGIN) break;
    }
    out.push({ slug: slugFor(o.origin), origin: o.origin, payTo, routes_indexed: o.routes.length, picked });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

async function probeOrigin(c, prev) {
  // Method is not in the Bazaar snapshot: try GET, then POST with an empty JSON body.
  const endpoints = [];
  const results = [];
  for (const r of c.picked) {
    const price_usdc = priceUsdc(r.price_atomic);
    let ep = { url: r.url, method: "GET", price_usdc };
    let res = await probeEndpoint(ep);
    if (res.reachable && !res.is_402) {
      const post = { url: r.url, method: "POST", price_usdc, body: {} };
      const r2 = await probeEndpoint(post);
      if (r2.is_402) { ep = post; res = r2; }
    }
    endpoints.push({ ...ep, description: r.description.slice(0, 140) });
    results.push(res);
  }
  const seller = { slug: c.slug, name: new URL(c.origin).hostname.replace(/^www\./, ""), homepage: c.origin, endpoints, payTo: c.payTo, networks: ["eip155:8453"] };
  const discovery = await probeDiscovery(seller);
  const all = (fn) => results.every(fn);
  const run = {
    at: new Date().toISOString(),
    endpoints: results,
    ...discovery,
    is_402: all((r) => r.is_402),
    envelope_valid: all((r) => r.envelope_valid),
    payto_match: all((r) => r.accepts.length > 0 && r.accepts.every((a) => String(a.payTo || "").toLowerCase() === c.payTo.toLowerCase())),
    header_envelope: all((r) => r.header_envelope),
    body_envelope: all((r) => r.body_envelope),
    x402_version_2: all((r) => r.x402_version === 2),
    mpp_header: results.some((r) => r.mpp_header),
    ms: Math.max(...results.map((r) => r.response_time_ms)),
    networks_detected: [...new Set(results.flatMap((r) => r.accepts.map((a) => a.network).filter(Boolean)))],
    pass: all((r) => r.is_402 && r.envelope_valid),
  };
  const probes = [...(prev.probes || []), run].slice(-8);
  const state = { probes, proof_check: null, forgemesh_paid: null, bazaar_listed: true };
  const c2 = compute(seller, state);
  return { seller, state, computed: c2, run };
}

// One feed row from a state file. Null when the latest probe did not pass (not payable).
function rowFrom(slug, st) {
  const run = (st.probes || []).slice(-1)[0];
  if (!run || !(run.is_402 && run.envelope_valid)) return null;
  const seller = st.seller;
  const computed = compute(seller, { probes: st.probes, proof_check: null, forgemesh_paid: null, bazaar_listed: true });
  const cheapest = seller.endpoints.reduce((a, b) => (Number(a.price_usdc) <= Number(b.price_usdc) ? a : b));
  const desc = String(seller.endpoints[0]?.description || "").slice(0, 120);
  return {
    slug, origin: seller.homepage, name: seller.name, payTo: seller.payTo, description: desc,
    routes_indexed: st.routes_indexed || seller.endpoints.length,
    endpoints: seller.endpoints.map((e) => ({ url: e.url, method: e.method, price_usdc: e.price_usdc })),
    cheapest_usdc: cheapest.price_usdc,
    score: computed.score, score_band: computed.score_band, max_score: 85, status: computed.status,
    networks_detected: computed.networks_detected,
    manifest_ok: !!run.manifest_ok, llms_ok: !!run.llms_ok, mpp_detected: !!run.mpp_header, ms: run.ms,
    probes: st.probes.length, last_probe: run.at, first_seen: st.first_seen || run.at,
    listed: computed.score >= LIST_MIN_SCORE,
    claim_url: CLAIM_URL, claim_price_usdc: CLAIM_PRICE_USDC,
  };
}

(async () => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (args.includes("--rebuild")) {
    // Rebuild dist/unclaimed.json from unclaimed/state without probing.
    const rows = [];
    for (const f of fs.readdirSync(STATE_DIR).filter((x) => x.endsWith(".json"))) {
      const r = rowFrom(f.replace(/\.json$/, ""), readJson(path.join(STATE_DIR, f)));
      if (r) rows.push(r);
    }
    rows.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
    writeFeed(rows, fs.readdirSync(STATE_DIR).filter((x) => x.endsWith(".json")).length);
    return;
  }
  let list = candidates();
  if (opt("--slug")) list = list.filter((c) => c.slug === opt("--slug"));
  if (opt("--limit")) list = list.slice(0, Number(opt("--limit")));
  console.log(`unclaimed: ${list.length} origin(s) to probe`);
  const queue = [...list];
  const rows = [];
  let done = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const c = queue.shift();
      const file = path.join(STATE_DIR, `${c.slug}.json`);
      const prev = fs.existsSync(file) ? readJson(file) : { probes: [] };
      try {
        const { seller, state, computed, run } = await probeOrigin(c, prev);
        writeJsonAtomic(file, { ...state, seller, routes_indexed: c.routes_indexed, updated_at: run.at });
        const row = rowFrom(c.slug, { ...state, seller, routes_indexed: c.routes_indexed, first_seen: prev.first_seen || run.at });
        if (row) rows.push(row);
      } catch (e) {
        console.error(`${c.slug}: ${e.message}`);
      }
      done += 1;
      if (done % 100 === 0) console.log(`  ${done}/${list.length}`);
    }
  });
  await Promise.all(workers);
  rows.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
  // Full run only: a --slug/--limit run must not shrink the published feed.
  const feedFile = path.join(DIRS.dist, "unclaimed.json");
  let merged = rows;
  if (opt("--slug") || opt("--limit")) {
    const old = fs.existsSync(feedFile) ? readJson(feedFile).rows || [] : [];
    const fresh = new Map(rows.map((r) => [r.slug, r]));
    merged = old.map((r) => fresh.get(r.slug) || r);
    for (const r of rows) if (!old.some((o) => o.slug === r.slug)) merged.push(r);
    merged.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
  }
  writeFeed(merged, done);
  if (!args.includes("--no-push")) {
    const feedFile = path.join(DIRS.dist, "unclaimed.json");
    const r = commitAndPush([feedFile], `Unclaimed index ${new Date().toISOString().slice(0, 10)}: ${merged.filter((x) => x.listed).length} listed of ${merged.length} payable`);
    console.log(r.committed ? `pushed ${r.sha}` : "no changes");
  }
})().catch((e) => { console.error(e); process.exit(1); });

function writeFeed(merged, probed) {
  const feedFile = path.join(DIRS.dist, "unclaimed.json");
  const feed = {
    version: 1, program: "x402", kind: "unclaimed-index", generated_at: new Date().toISOString(), score_spec: SPEC,
    source: "CDP Bazaar snapshot, probed by ForgeMesh on protocol facts only; no seller input",
    note: "Unclaimed rows have no proof tx, so the ceiling is 85/100. Claiming adds contact, routes, the README badge and re-probe on demand; a proof tx added by PR unlocks the last 15 points. The free GitHub PR path is unchanged.",
    claim: { url: CLAIM_URL, price_usdc: CLAIM_PRICE_USDC, method: "POST", ownership: ["pay the fee from the row's payTo wallet", "or publish the returned token at /.well-known/x402 or llms.txt"], docs: "https://router.forgemesh.io/openapi.json" },
    free_path: "https://github.com/forgemeshlabs/x402-verified/blob/main/CONTRIBUTING.md",
    list_min_score: LIST_MIN_SCORE,
    counts: { probed, payable: merged.length, listed: merged.filter((r) => r.listed).length },
    rows: merged,
  };
  writeJsonAtomic(feedFile, feed);
  console.log(`unclaimed feed: ${feed.counts.payable} payable origins, ${feed.counts.listed} listed (>= ${LIST_MIN_SCORE}) -> dist/unclaimed.json`);
}
