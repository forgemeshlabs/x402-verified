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
const { probeSeller, fetchText } = require("./lib/probe");
// Claim fee wallet and price, as published at router.forgemesh.io (POST /api/verified/claim). Public facts.
const CLAIM_FEE_WALLET = "0xC7cED5079D619478aaeb0c54C3673E83C5b4A020";
const CLAIM_FEE_USDC = "5";
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

// Where a claim token may be published: the origin's manifest or llms.txt, or the default branch of a
// GitHub repo that either of those files links to (README.md or a .forgemesh-claim file). Returns the
// URL where the token was seen, or null.
async function tokenPublished(s) {
  const origin = new URL(s.homepage).origin;
  const token = String(s.claim.token || "");
  if (!/^forgemesh-claim-[a-f0-9]{24}$/.test(token)) return null;
  const files = [`${origin}/.well-known/x402`, `${origin}/llms.txt`];
  const texts = await Promise.all(files.map((u) => fetchText(u)));
  for (let i = 0; i < files.length; i++) if (typeof texts[i] === "string" && texts[i].includes(token)) return files[i];
  const repos = new Set();
  for (const txt of texts) for (const m of String(txt || "").matchAll(/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)/g)) repos.add(`${m[1]}/${m[2].replace(/\.git$/, "")}`);
  for (const repo of [...repos].slice(0, 3)) {
    for (const branch of ["main", "master"]) {
      for (const file of ["README.md", ".forgemesh-claim"]) {
        const u = `https://raw.githubusercontent.com/${repo}/${branch}/${file}`;
        const body = await fetchText(u);
        if (typeof body === "string" && body.includes(token)) return u;
      }
    }
  }
  return null;
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

  // Claimed records (claim present, proof absent) skip the proof check: the 15 proof points stay at 0
  // until the seller adds a proof tx by PR. A record that carries both must satisfy the proof.
  let proof = null;
  if (s.proof) {
    const proofEp = s.endpoints[s.proof.endpoint];
    proof = await verifyUsdcTransfer({ txHash: s.proof.tx_hash, payTo: s.payTo, minAmountAtomic: usdcToAtomic(proofEp.price_usdc), maxAgeDays: 30 });
    report.proof = proof;
    if (!proof.ok) report.errors.push(`proof ${s.proof.tx_hash}: ${proof.reason}`);
  } else if (s.claim) {
    // A claim block is a statement, not evidence. CI re-verifies it with no secrets: the fee must be a
    // settled USDC transfer of at least CLAIM_FEE_USDC to the published fee wallet, sent by claim.payer,
    // and ownership must hold: payer-wallet means the fee came from the record's own payTo; manifest-token
    // means the token is visible right now at the origin's /.well-known/x402 or llms.txt.
    if (s.claim.tx_hash) {
      const fee = await verifyUsdcTransfer({ txHash: s.claim.tx_hash, payTo: CLAIM_FEE_WALLET, minAmountAtomic: usdcToAtomic(CLAIM_FEE_USDC), maxAgeDays: 30 });
      report.claim = fee;
      if (!fee.ok) report.errors.push(`claim fee ${s.claim.tx_hash}: ${fee.reason}`);
      else if (String(fee.payer).toLowerCase() !== String(s.claim.payer).toLowerCase()) report.errors.push(`claim fee was paid by ${fee.payer}, not the declared claim.payer ${s.claim.payer}`);
    } else if (s.claim.stripe_session) {
      // Card fee: nothing in CI can check Stripe. The verdict step reads this marker and withholds
      // the fast track, so a maintainer confirms the session in Stripe and merges by hand.
      report.maintainer_required = `card claim ${s.claim.stripe_session}: confirm the paid session in Stripe before merging`;
      if (s.claim.ownership !== "manifest-token") report.errors.push("card claims must use manifest-token ownership");
    }
    if (s.claim.ownership === "payer-wallet") {
      if (String(s.claim.payer).toLowerCase() !== String(s.payTo).toLowerCase()) report.errors.push(`payer-wallet claim: claim.payer ${s.claim.payer} is not the record's payTo ${s.payTo}`);
    } else if (s.claim.ownership === "manifest-token") {
      const found = await tokenPublished(s);
      if (!found) report.errors.push(`manifest-token claim: token not found at the origin's /.well-known/x402 or llms.txt, nor in a GitHub repo those files link to (keep it published; the claim is re-checked on every validation)`);
      else report.warnings.push(`claim token found at ${found}`);
    }
    report.warnings.push("claimed record without a proof tx: payability proof points (15) stay unearned until a proof is added");
  }

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
    if (r.claim) lines.push(`Claim fee: ${r.claim.ok ? `verified, ${Number(r.claim.amount_atomic) / 1e6} USDC from ${r.claim.payer} in block ${r.claim.block}` : r.claim.reason}`);
    if (r.maintainer_required) lines.push(`- 🧑 MAINTAINER-REVIEW: ${r.maintainer_required}`);
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
