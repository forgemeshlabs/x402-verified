#!/usr/bin/env node
"use strict";
// Regenerates README tables, dist/verified.json (the canonical machine feed) and badges/*.json.
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, DIRS, loadSellers, loadPartners, loadState, readJson, writeJsonAtomic, feedErrors } = require("./lib/sellers");
const { compute } = require("./lib/score");
const { SPEC } = require("./lib/rubrics/x402");

const SITE = "https://forgemesh.io";
const DISCLAIMER = "x402 Verified by ForgeMesh is an independent ForgeMesh program. It is not an x402 Foundation or Coinbase certification, endorsement, or official program. A listing records checks and a settled payment at a point in time; it is not a warranty or guarantee.";
const MARKS = {
  score: "ForgeMesh Verified Score, 0-100: current technical quality of the x402 implementation.",
  forgemesh_paid: "$ ForgeMesh Paid: ForgeMesh itself completed and independently verified a real x402 transaction with the seller.",
  perfect: "★ Perfect: the seller currently scores exactly 100/100.",
  status: "active | degraded | delisted: current operating health.",
};
const COLORS = { excellent: "2ea44f", ready: "3b82f6", friction: "e0a100", "at-risk": "e05d44", delisted: "9f9f9f" };

function badgeMessage(c) {
  const parts = [c.status === "delisted" ? "delisted" : `${c.score}/100`];
  if (c.perfect) parts.push("★");
  if (c.forgemesh_paid) parts.push("$");
  return parts.join(" · ");
}
function badgeColor(c) { return c.status === "delisted" ? COLORS.delisted : COLORS[c.score_band]; }

function sellerRecord(entry) {
  const s = entry.data;
  const state = loadState(s.slug);
  const c = compute(s, state);
  return {
    slug: s.slug, name: s.name, homepage: s.homepage, description: s.description,
    protocols: s.protocols, endpoints: s.endpoints, nominated_endpoint: s.nominated_endpoint ?? 0,
    payTo: s.payTo, networks: s.networks, networks_detected: c.networks_detected,
    score: c.score, score_band: c.score_band, dimensions: c.dimensions, score_details: c.score_details,
    status: c.status, perfect: c.perfect,
    forgemesh_paid: c.forgemesh_paid, forgemesh_paid_at: c.forgemesh_paid_at, forgemesh_paid_tx: c.forgemesh_paid_tx,
    forgemesh_paid_amount_atomic: c.forgemesh_paid_amount_atomic, forgemesh_paid_stale: c.forgemesh_paid_stale,
    proof: s.proof, proof_check: state.proof_check || null,
    probes: (state.probes || []).slice(-8).map((p) => ({ at: p.at, pass: p.pass, is_402: p.is_402, envelope_valid: p.envelope_valid, payto_match: p.payto_match, header_envelope: p.header_envelope, body_envelope: p.body_envelope, x402_version_2: p.x402_version_2, mpp_header: p.mpp_header, ms: p.ms, manifest_ok: p.manifest_ok, manifest_lists_route: p.manifest_lists_route, llms_ok: p.llms_ok })),
    last_probe: c.last_probe, bazaar_listed: !!state.bazaar_listed,
    protocol_capabilities: c.protocol_capabilities, contact: s.contact, added_at: s.added_at,
    page: `${SITE}/partners/${s.slug}`, badge: `${SITE}/badge/x402/${s.slug}`,
  };
}

function replaceBlock(text, name, body) {
  const start = `<!-- ${name}:START -->`, end = `<!-- ${name}:END -->`;
  const i = text.indexOf(start), j = text.indexOf(end);
  if (i < 0 || j < 0) throw new Error(`README is missing ${start}/${end} markers`);
  return text.slice(0, i + start.length) + "\n" + body.trim() + "\n" + text.slice(j);
}

function sellerTable(rows) {
  if (!rows.length) return "_No sellers yet. Be the first: see CONTRIBUTING.md._";
  const head = "| Seller | Score | Marks | Status | Protocols | Cheapest route | Proof | Last probe |\n|---|---|---|---|---|---|---|---|";
  const body = rows.map((r) => {
    const marks = [r.perfect ? "★" : "", r.forgemesh_paid ? "$" : ""].filter(Boolean).join(" ") || "—";
    const cheapest = r.endpoints.reduce((a, b) => (Number(a.price_usdc) <= Number(b.price_usdc) ? a : b));
    const protocols = `x402 ✓${r.protocol_capabilities.mpp?.supported ? " · MPP detected" : ""}`;
    const proof = r.proof_check?.ok ? `[tx](https://basescan.org/tx/${r.proof.tx_hash})` : "pending";
    return `| [${r.name}](${r.page}) | ${r.score}/100 ${r.score_band} | ${marks} | ${r.status} | ${protocols} | ${cheapest.method} ${cheapest.url} $${cheapest.price_usdc} | ${proof} | ${r.last_probe ? r.last_probe.slice(0, 10) : "—"} |`;
  });
  return [head, ...body].join("\n");
}

function partnerTable(partners) {
  if (!partners.length) return "_None yet._";
  const head = "| Partner | Kind | Status | What |\n|---|---|---|---|";
  return [head, ...partners.map((p) => `| [${p.name}](${p.homepage}) | ${p.kind} | ${p.status}${p.status_note ? ` (${p.status_note})` : ""} | ${p.description} |`)].join("\n");
}

(function main() {
  const sellers = loadSellers().map(sellerRecord).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const partners = loadPartners().sort((a, b) => a.name.localeCompare(b.name));
  const feedPath = path.join(DIRS.dist, "verified.json");
  const feed = { version: 2, program: "x402", generated_at: new Date().toISOString(), score_spec: SPEC, disclaimer: DISCLAIMER, marks: MARKS, sellers, partners };
  // Keep generated_at stable when nothing else changed, so bots do not commit timestamp-only churn.
  if (fs.existsSync(feedPath)) {
    try {
      const prev = readJson(feedPath);
      const strip = (f) => JSON.stringify({ ...f, generated_at: null, sellers: f.sellers.map((s) => ({ ...s, score_details: undefined })) });
      if (strip(prev) === strip(feed)) feed.generated_at = prev.generated_at;
    } catch { /* regenerate */ }
  }
  const errs = feedErrors(feed);
  if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
  writeJsonAtomic(feedPath, feed);

  fs.mkdirSync(DIRS.badges, { recursive: true });
  for (const s of sellers) {
    writeJsonAtomic(path.join(DIRS.badges, `${s.slug}.json`), { schemaVersion: 1, label: "x402 Verified by ForgeMesh", message: badgeMessage(s), color: badgeColor(s), cacheSeconds: 300 });
  }
  const readmePath = path.join(ROOT, "README.md");
  let readme = fs.readFileSync(readmePath, "utf8");
  const live = sellers.filter((s) => s.status !== "delisted");
  const delisted = sellers.filter((s) => s.status === "delisted");
  readme = replaceBlock(readme, "SELLERS", sellerTable(live));
  readme = replaceBlock(readme, "DELISTED", delisted.length ? sellerTable(delisted) : "_None._");
  readme = replaceBlock(readme, "PARTNERS", partnerTable(partners));
  fs.writeFileSync(readmePath, readme);
  console.log(`built: ${sellers.length} sellers (${live.length} live, ${delisted.length} delisted), ${partners.length} partners`);
})();
