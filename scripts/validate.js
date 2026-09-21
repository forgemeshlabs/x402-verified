#!/usr/bin/env node
"use strict";
// Validates seller records. Runs in CI on pull_request with NO secrets, and locally.
//   node scripts/validate.js --base origin/main   # only sellers changed vs base
//   node scripts/validate.js --all                # every seller
//   node scripts/validate.js --slug humanmirror   # one seller
// Exit 1 on any hard failure. Writes a markdown report to --out and $GITHUB_STEP_SUMMARY.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ROOT, DIRS, loadSellers, loadPartners, loadState, saveState, staticErrors, partnerErrors } = require("./lib/sellers");
const { probeSeller } = require("./lib/probe");
const { verifyUsdcTransfer, usdcToAtomic } = require("./lib/receipt");
const { compute } = require("./lib/score");

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const flag = (name) => args.includes(name);

function changedSellerFiles(base) {
  const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").filter((f) => f.startsWith("sellers/") && f.endsWith(".json")).map((f) => path.join(ROOT, f));
}

function nonSellerChanges(base) {
  const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").filter(Boolean).filter((f) => !f.startsWith("sellers/"));
}

async function validateSeller(entry, all, { recordProbe }) {
  const s = entry.data;
  const report = { slug: s.slug || path.basename(entry.file, ".json"), errors: [], warnings: [], probe: null, proof: null, score: null };
  report.errors.push(...staticErrors(entry, all));
  if (report.errors.length) return report;

  const run = await probeSeller(s);
  report.probe = run;
  run.endpoints.forEach((r, i) => {
    const ep = s.endpoints[i];
    if (!r.reachable) report.errors.push(`${ep.method} ${ep.url}: unreachable (${r.error})`);
    else if (!r.is_402) report.errors.push(`${ep.method} ${ep.url}: expected HTTP 402, got ${r.http_status}`);
    else if (!r.envelope_valid) report.errors.push(`${ep.method} ${ep.url}: invalid x402 envelope (${r.envelope_errors.join("; ")})`);
    else {
      // Only the accepts on the seller's declared networks must pay to the declared wallet. Sellers may
      // also accept other rails (e.g. Solana) with their own addresses; those are "detected", never scored.
      const declared = new Set((s.networks || ["eip155:8453"]).map((n) => String(n).toLowerCase()));
      const onDeclared = r.accepts.filter((a) => declared.has(String(a.network || "").toLowerCase()));
      if (!onDeclared.length) report.errors.push(`${ep.method} ${ep.url}: envelope offers none of the declared networks (${[...declared].join(", ")})`);
      else if (!onDeclared.every((a) => String(a.payTo || "").toLowerCase() === s.payTo.toLowerCase())) report.errors.push(`${ep.method} ${ep.url}: envelope payTo on ${[...declared].join(", ")} does not match declared payTo ${s.payTo}`);
    }
  });
  if (!run.manifest_ok) report.warnings.push(`no x402 manifest at ${run.manifest_url} (discoverability points)`);
  else if (!run.manifest_lists_route) report.warnings.push("manifest does not name every declared route (discoverability points)");
  if (!run.llms_ok) report.warnings.push(`no llms.txt at ${run.llms_url} (discoverability points)`);
  if (!run.header_envelope) report.warnings.push("envelope not delivered in the payment-required header (interoperability points)");
  if (!run.body_envelope) report.warnings.push("no envelope in the JSON body; stock v1 clients cannot pay (interoperability points)");

  const proofEp = s.endpoints[s.proof.endpoint];
  const proof = await verifyUsdcTransfer({ txHash: s.proof.tx_hash, payTo: s.payTo, minAmountAtomic: usdcToAtomic(proofEp.price_usdc), maxAgeDays: 30 });
  report.proof = proof;
  if (!proof.ok) report.errors.push(`proof ${s.proof.tx_hash}: ${proof.reason}`);

  // Provisional score from this run so submitters see where they land.
  const state = loadState(report.slug);
  const probes = [...(state.probes || []), run].slice(-8);
  const provisional = compute(s, { ...state, probes, proof_check: proof });
  report.score = provisional;
  if (recordProbe) saveState(report.slug, { ...state, probes, proof_check: proof });
  return report;
}

function md(reports, partnerReports) {
  const lines = ["## x402 Verified validation", ""];
  for (const r of reports) {
    const ok = r.errors.length === 0;
    lines.push(`### ${ok ? "✅" : "❌"} ${r.slug}`);
    if (r.score) lines.push(`Provisional ForgeMesh Verified Score: **${r.score.score}/100** (${r.score.score_band})  · payability ${r.score.dimensions.payability}/40 · reliability ${r.score.dimensions.reliability}/20 · interoperability ${r.score.dimensions.interoperability}/20 · discoverability ${r.score.dimensions.discoverability}/20`);
    if (r.probe) lines.push(`Protocols: x402 ${r.probe.is_402 && r.probe.envelope_valid ? "✓" : "✗"}${r.probe.mpp_header ? " · MPP detected" : ""} · networks detected: ${r.probe.networks_detected.join(", ") || "none"}`);
    if (r.proof) lines.push(`Proof: ${r.proof.ok ? `verified, ${Number(r.proof.amount_atomic) / 1e6} USDC in block ${r.proof.block}` : r.proof.reason}`);
    for (const e of r.errors) lines.push(`- ❌ ${e}`);
    for (const w of r.warnings) lines.push(`- ⚠️ ${w}`);
    lines.push("");
  }
  for (const p of partnerReports) {
    lines.push(`### ${p.errors.length ? "❌" : "✅"} partner ${p.slug}`);
    for (const e of p.errors) lines.push(`- ❌ ${e}`);
    lines.push("");
  }
  return lines.join("\n");
}

(async () => {
  const all = loadSellers();
  let targets;
  const base = opt("--base");
  if (flag("--all")) targets = all;
  else if (opt("--slug")) targets = all.filter((e) => e.data.slug === opt("--slug"));
  else if (base) {
    const changed = changedSellerFiles(base);
    targets = all.filter((e) => changed.includes(e.file));
    const other = nonSellerChanges(base);
    if (other.length && !process.env.X402V_MAINTAINER) {
      console.log(`Non-seller paths changed: ${other.join(", ")}. Contributor PRs may only touch sellers/<slug>.json; maintainers review these by hand.`);
    }
  } else { console.error("usage: validate.js --all | --base <ref> | --slug <slug>"); process.exit(2); }

  const reports = [];
  for (const entry of targets) reports.push(await validateSeller(entry, all, { recordProbe: flag("--record") }));
  const partnerReports = loadPartners().map((p) => ({ slug: p.slug, errors: partnerErrors(p) }));

  const report = md(reports, partnerReports);
  console.log(report);
  const out = opt("--out");
  if (out) fs.writeFileSync(out, report);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  const failed = reports.some((r) => r.errors.length) || partnerReports.some((p) => p.errors.length);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
