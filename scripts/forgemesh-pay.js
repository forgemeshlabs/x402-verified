#!/usr/bin/env node
"use strict";
// ForgeMesh Paid: ForgeMesh itself buys one real call from the seller's nominated route and
// publishes the receipt. VPS ONLY. Never runs in GitHub Actions; the burner key never leaves
// the VPS. Eligibility is not entitlement: every guard below must pass, and ForgeMesh keeps
// discretion within a monthly budget.
//   node scripts/forgemesh-pay.js <slug> [--dry-run] [--env /path/.env] [--no-push]
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DIRS, loadSellers, loadState, saveState, readJson, writeJsonAtomic } = require("./lib/sellers");
const { probeSeller } = require("./lib/probe");
const { verifyUsdcTransfer, usdcToAtomic } = require("./lib/receipt");
const { compute } = require("./lib/score");
const { commitAndPush } = require("./lib/git");

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith("--"));
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const dryRun = args.includes("--dry-run");
require("dotenv").config({ path: opt("--env") || "/home/ubuntu/dev/x402-services/.env" });

const MAX_PRICE_USDC = 0.01;
const MIN_SCORE = 85;
const MIN_RUNS = 2;
const MIN_GAP_MS = 60 * 60 * 1000;
const MAX_LATEST_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const BUDGET_USDC = Number(process.env.FORGEMESH_PAY_BUDGET_USDC || "1");
const BUDGET_FILE = path.join(DIRS.state, "_budget.json");

function refuse(msg) { console.log(`REFUSED: ${msg}`); process.exit(3); }

function budget() {
  const month = new Date().toISOString().slice(0, 7);
  const b = fs.existsSync(BUDGET_FILE) ? readJson(BUDGET_FILE) : {};
  return { month, spent: Number(b[month]?.usdc || 0), count: Number(b[month]?.count || 0), all: b };
}

function findTxHash(value) {
  if (typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value)) return value;
  if (!value || typeof value !== "object") return null;
  for (const k of ["txHash", "tx_hash", "transactionHash", "transaction_hash", "hash"]) {
    if (typeof value[k] === "string" && /^0x[a-fA-F0-9]{64}$/.test(value[k])) return value[k];
  }
  for (const item of Object.values(value)) { const f = findTxHash(item); if (f) return f; }
  return null;
}

// Base RPC / facilitator clock skew guard, kept from x402-services/scripts/low-cost-paid-sweep.js.
async function createChainTimedPaymentPayload(httpClient, publicClient, paymentRequired) {
  try {
    const block = await publicClient.getBlock();
    const chainNow = Number(block.timestamp);
    const originalNow = Date.now;
    const localNow = Math.floor(originalNow() / 1000);
    const timeout = Number(paymentRequired.accepts?.[0]?.maxTimeoutSeconds || 300);
    const signingNow = Math.min(Math.max(chainNow, localNow + 30 - timeout), chainNow + 600);
    Date.now = () => signingNow * 1000;
    try { return await httpClient.createPaymentPayload(paymentRequired); } finally { Date.now = originalNow; }
  } catch { return httpClient.createPaymentPayload(paymentRequired); }
}

(async () => {
  if (!slug) { console.error("usage: forgemesh-pay.js <slug> [--dry-run]"); process.exit(2); }
  const entry = loadSellers().find((e) => e.data.slug === slug);
  if (!entry) refuse(`no seller ${slug}`);
  const s = entry.data;
  const state = loadState(slug);
  const idx = s.nominated_endpoint ?? 0;
  const route = s.endpoints[idx];

  // 1-4. Fresh unpaid probe of every declared endpoint, envelope, payTo alignment.
  const run = await probeSeller(s);
  if (!run.is_402 || !run.envelope_valid) refuse("latest probe: not every endpoint answers 402 with a valid envelope");
  if (!run.payto_match) refuse("envelope payTo differs from the declared payTo");
  // 5. Seller-supplied proof.
  const proofEp = s.endpoints[s.proof.endpoint];
  const proof = state.proof_check?.ok ? state.proof_check : await verifyUsdcTransfer({ txHash: s.proof.tx_hash, payTo: s.payTo, minAmountAtomic: usdcToAtomic(proofEp.price_usdc), maxAgeDays: 30 });
  if (!proof.ok) refuse(`seller proof: ${proof.reason}`);
  // Record this run so it counts as an independent probe.
  state.probes = [...(state.probes || []), run].slice(-8);
  state.proof_check = proof;
  if (!dryRun) saveState(slug, state);
  // 6-8. Score, status.
  const c = compute(s, state);
  console.log(`score ${c.score}/100 (${c.score_band}) status=${c.status} runs=${state.probes.length}`);
  if (c.score < MIN_SCORE) refuse(`score ${c.score} is below ${MIN_SCORE}`);
  if (c.status !== "active") refuse(`status is ${c.status}`);
  // 9. Two successful independent runs, >=1h apart, latest <=7 days old.
  const passes = state.probes.filter((p) => p.pass).map((p) => Date.parse(p.at)).sort((a, b) => a - b);
  const latest = passes[passes.length - 1];
  if (passes.length < MIN_RUNS) refuse(`needs a second successful probe run at least 1h after ${new Date(latest).toISOString()} (run: node scripts/reprobe.js --slug ${slug})`);
  const spread = passes.some((t, i) => i > 0 && t - passes[i - 1] >= MIN_GAP_MS) || latest - passes[0] >= MIN_GAP_MS;
  if (!spread) refuse(`successful probe runs are less than 1h apart; run reprobe.js --slug ${slug} after ${new Date(passes[0] + MIN_GAP_MS).toISOString()}`);
  if (Date.now() - latest > MAX_LATEST_AGE_MS) refuse("latest successful probe is older than 7 days");
  // 10-11. Anti-abuse and price cap.
  if (Number(route.price_usdc) > MAX_PRICE_USDC) refuse(`nominated route costs ${route.price_usdc}, cap is ${MAX_PRICE_USDC}`);
  const b = budget();
  if (b.spent + Number(route.price_usdc) > BUDGET_USDC) refuse(`monthly budget ${BUDGET_USDC} USDC would be exceeded (spent ${b.spent})`);
  if (state.forgemesh_paid?.tx_hash && !c.forgemesh_paid_stale) refuse(`already paid on ${state.forgemesh_paid.paid_at} and not yet stale`);
  console.log(`eligible: ${route.method} ${route.url} for $${route.price_usdc}`);
  if (dryRun) { console.log("dry run: no payment made"); return; }

  // 12. Real x402 purchase.
  const key = process.env.BURNER_PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY;
  if (!key) refuse("BURNER_PRIVATE_KEY not set");
  const { x402Client, x402HTTPClient } = require("@x402/core/client");
  const { ExactEvmScheme } = require("@x402/evm/exact/client");
  const { toClientEvmSigner } = require("@x402/evm");
  const { privateKeyToAccount } = require("viem/accounts");
  const { createPublicClient, http } = require("viem");
  const { base } = require("viem/chains");
  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
  const httpClient = new x402HTTPClient(new x402Client().register("eip155:*", new ExactEvmScheme(toClientEvmSigner(account))));
  const init = { method: route.method, headers: { "content-type": "application/json", "user-agent": "x402-verified/2.0 (+https://forgemesh.io/partners)" }, body: route.method === "POST" ? JSON.stringify(route.body ?? {}) : undefined };
  const challenge = await fetch(route.url, init);
  if (challenge.status !== 402) refuse(`expected 402 at purchase time, got ${challenge.status}`);
  let challengeBody; try { challengeBody = await challenge.clone().json(); } catch { /* header-only */ }
  const required = httpClient.getPaymentRequiredResponse((n) => challenge.headers.get(n), challengeBody);
  const payload = await createChainTimedPaymentPayload(httpClient, publicClient, required);
  const paid = await fetch(route.url, { ...init, headers: { ...init.headers, ...httpClient.encodePaymentSignatureHeader(payload) } });
  const text = await paid.text();
  // 13. Successful application response.
  if (!paid.ok) refuse(`paid request returned ${paid.status}: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  // 14. Transaction hash.
  let settle = null; try { settle = httpClient.getPaymentSettleResponse((n) => paid.headers.get(n)); } catch { /* none */ }
  const txHash = findTxHash(settle) || findTxHash(paid.headers.get("payment-response")) || null;
  if (!txHash) refuse("paid response carried no settlement transaction hash");
  console.log(`paid ${paid.status}, tx ${txHash}; waiting for confirmations`);
  // 15-16. Receipt + confirmations.
  let receipt;
  for (let i = 0; i < 30; i++) {
    receipt = await verifyUsdcTransfer({ txHash, payTo: s.payTo, minAmountAtomic: usdcToAtomic(route.price_usdc), minConfirmations: 10 });
    if (receipt.ok) break;
    if (!/confirmations|not found/.test(receipt.reason || "")) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  if (!receipt.ok) refuse(`settlement receipt: ${receipt.reason}`);
  // 17. Evidence into bot-owned state, budget ledger.
  state.forgemesh_paid = { tx_hash: txHash, block: receipt.block, block_time: receipt.block_time, amount_atomic: receipt.amount_atomic, payer: account.address, paid_at: new Date().toISOString(), endpoint: idx, response_status: paid.status };
  saveState(slug, state);
  b.all[b.month] = { usdc: +(b.spent + Number(route.price_usdc)).toFixed(6), count: b.count + 1 };
  writeJsonAtomic(BUDGET_FILE, b.all);
  // 18. Rebuild + push.
  execFileSync(process.execPath, [path.join(__dirname, "build.js")], { stdio: "inherit" });
  if (!args.includes("--no-push")) {
    const r = commitAndPush([path.join(DIRS.state, `${slug}.json`), BUDGET_FILE, "README.md", "dist", "badges"], `ForgeMesh Paid: ${slug} ${txHash}`);
    console.log(r.committed ? `pushed ${r.sha}` : "no changes");
  }
  console.log(`ForgeMesh Paid: ${slug} https://basescan.org/tx/${txHash}`);
})().catch((e) => { console.error(e); process.exit(1); });
