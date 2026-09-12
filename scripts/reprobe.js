#!/usr/bin/env node
"use strict";
// VPS-side probe run. Weekly cron for all sellers, or --slug <slug> for one (used to establish
// the second independent probe run before ForgeMesh Paid). Never runs in GitHub Actions.
//   node scripts/reprobe.js [--slug <slug>] [--no-push]
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DIRS, loadSellers, loadState, saveState } = require("./lib/sellers");
const { probeSeller } = require("./lib/probe");
const { verifyUsdcTransfer, usdcToAtomic } = require("./lib/receipt");
const { statusFrom } = require("./lib/score");
const { commitAndPush } = require("./lib/git");

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const BAZAAR_DB = process.env.BAZAAR_DB || "/home/ubuntu/repos/x402-forgemesh-stuffer/var/bazaar.db";
const SQLITE3 = process.env.SQLITE3_BIN || "sqlite3";

function bazaarListed(seller) {
  try {
    const origin = new URL(seller.endpoints[0].url).origin;
    const out = execFileSync(SQLITE3, [BAZAAR_DB, `select count(*) from resources where resource like '${origin.replace(/'/g, "''")}%';`], { encoding: "utf8", timeout: 10000 }).trim();
    return Number(out) > 0;
  } catch { return null; } // unknown: keep the previous value
}

(async () => {
  const targets = loadSellers().filter((e) => !opt("--slug") || e.data.slug === opt("--slug"));
  const touched = [];
  for (const entry of targets) {
    const s = entry.data;
    const state = loadState(s.slug);
    if (statusFrom(state.probes) === "delisted" && !opt("--slug")) continue; // delisted sellers relist via a new PR
    const run = await probeSeller(s);
    state.probes = [...(state.probes || []), run].slice(-8);
    if (!state.proof_check?.ok) {
      const ep = s.endpoints[s.proof.endpoint];
      state.proof_check = await verifyUsdcTransfer({ txHash: s.proof.tx_hash, payTo: s.payTo, minAmountAtomic: usdcToAtomic(ep.price_usdc), maxAgeDays: 30 });
    }
    const bz = bazaarListed(s);
    if (bz !== null) state.bazaar_listed = bz;
    state.status = statusFrom(state.probes);
    saveState(s.slug, state);
    touched.push(path.join(DIRS.state, `${s.slug}.json`));
    console.log(`${s.slug}: ${run.pass ? "pass" : "FAIL"} ${run.ms}ms status=${state.status}`);
  }
  if (!touched.length) { console.log("nothing to probe"); return; }
  execFileSync(process.execPath, [path.join(__dirname, "build.js")], { stdio: "inherit" });
  if (!args.includes("--no-push")) {
    const r = commitAndPush([...touched, "README.md", "dist", "badges"], `Reprobe ${new Date().toISOString().slice(0, 10)}: ${touched.length} seller${touched.length === 1 ? "" : "s"}`);
    console.log(r.committed ? `pushed ${r.sha}` : "no changes");
  }
})().catch((e) => { console.error(e); process.exit(1); });
