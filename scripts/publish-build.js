#!/usr/bin/env node
"use strict";
// Trusted VPS worker in a disposable checkout. No payments and no source merges.
// --prepare-only records first probes and builds without any GitHub mutation.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ROOT, loadSellers, loadState } = require("./lib/sellers");
const { git } = require("./lib/git");
const { assertGeneratedPaths, initialProbeNeeded } = require("./lib/publication");
const REPO = "forgemeshlabs/x402-verified";
const BRANCH = "automation/published-directory";
const gh = (args) => execFileSync("gh", args, { cwd: ROOT, encoding: "utf8" }).trim();
const node = (...args) => execFileSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });

function main() {
  if (git(["status", "--porcelain"])) throw new Error("publisher requires a clean disposable checkout");
  const base = git(["rev-parse", "HEAD"]);
  const remoteBranch = git(["ls-remote", "--heads", "origin", `refs/heads/${BRANCH}`]).split(/\s/)[0];
  for (const { data: seller } of loadSellers()) {
    const initial = initialProbeNeeded(loadState(seller.slug));
    if (!initial && !process.argv.includes("--reprobe-all")) continue;
    node(path.join(__dirname, "reprobe.js"), "--slug", seller.slug, "--no-push");
    const state = loadState(seller.slug);
    if (initial && (!state.proof_check?.ok || !state.probes?.at(-1)?.pass)) {
      throw new Error(`initial verification failed for ${seller.slug}; will retry without publishing`);
    }
  }
  node(path.join(__dirname, "build.js"));
  git(["add", "--", "README.md", "dist", "badges", "state"]);
  const changed = git(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
  if (!changed.length) { console.log("publication already current"); return; }
  assertGeneratedPaths(changed);
  if (process.argv.includes("--prepare-only")) { console.log("publication prepared; no push or merge"); return; }
  if (git(["ls-remote", "origin", "refs/heads/main"]).split(/\s/)[0] !== base) {
    throw new Error("main changed while building; retry from latest main");
  }
  git(["-c", "user.name=x402-verified-bot", "-c", "user.email=hello@forgemesh.io",
    "commit", "-q", "-m", "Publish verified directory, README and badges"]);
  const sha = git(["rev-parse", "HEAD"]);
  // Explicit lease protects concurrent publishers. Never force-push main.
  git(["push", "-q", `--force-with-lease=refs/heads/${BRANCH}:${remoteBranch}`, "origin", `HEAD:refs/heads/${BRANCH}`]);
  const existing = JSON.parse(gh(["pr", "list", "--repo", REPO, "--state", "open", "--head", BRANCH, "--json", "number"]));
  let number = existing[0]?.number;
  if (!number) {
    const bodyFile = path.join(ROOT, ".git", "publication-body.md");
    fs.writeFileSync(bodyFile, `Publishes derived output from already-reviewed main (${base}).\n\nInitial seller probes and receipt checks are recorded before building. Only README.md, dist/verified.json, badges/*.json and state/*.json may change. No payments or source changes. The publisher verifies the exact head and merges this generated update automatically, then syncs the website.\n`);
    const url = gh(["pr", "create", "--repo", REPO, "--base", "main", "--head", BRANCH,
      "--title", "Publish verified directory, README and badges", "--body-file", bodyFile]);
    number = Number(url.split("/").at(-1));
  }
  const pr = JSON.parse(gh(["pr", "view", String(number), "--repo", REPO, "--json", "headRefOid,baseRefName,files"]));
  if (pr.headRefOid !== sha || pr.baseRefName !== "main") throw new Error("publication PR head/base changed");
  assertGeneratedPaths(pr.files.map(f => f.path));
  gh(["pr", "merge", String(number), "--repo", REPO, "--squash", "--match-head-commit", sha]);
  const merged = JSON.parse(gh(["pr", "view", String(number), "--repo", REPO, "--json", "state"]));
  if (merged.state !== "MERGED") throw new Error("publication PR was not merged; refusing site sync");
  console.log(`published: https://github.com/${REPO}/pull/${number}`);
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
