"use strict";
const { execFileSync } = require("node:child_process");
const { ROOT } = require("./sellers");

function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}
function gh(args) {
  return execFileSync("gh", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// Plain commit messages only: the operator's global commit-msg hook rejects AI attribution trailers.
//
// main is pull-request-only (branch protection, 2026-09-16). Generated files (README tables, dist feed,
// badges, probe state) therefore travel the same road as every seller: a branch, a pull request, CI.
// The direct push is attempted first so this keeps working if a bypass is ever granted to the bot.
// The PR is left OPEN for a maintainer to merge — automation does not merge its own work.
function commitAndPush(paths, message, { push = true } = {}) {
  git(["add", "--", ...paths]);
  const staged = git(["diff", "--cached", "--name-only"]);
  if (!staged) return { committed: false, pushed: false };
  git(["-c", "user.name=x402-verified-bot", "-c", "user.email=hello@forgemesh.io", "commit", "-q", "-m", message]);
  const sha = git(["rev-parse", "--short", "HEAD"]);
  if (!push) return { committed: true, pushed: false, sha };
  try {
    git(["push", "-q", "origin", "HEAD:main"]);
    return { committed: true, pushed: true, sha, via: "push" };
  } catch (err) {
    if (!/protected branch|GH006|pull request/i.test(String(err.stderr || err.message))) throw err;
  }
  const branch = `auto/${message.split(":")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
  git(["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
  const url = gh(["pr", "create", "--base", "main", "--head", branch, "--title", `${message} 🤖🤖🤖`, "--body",
    "Generated files only (`scripts/build.js` / `scripts/reprobe.js` on the VPS). Opened automatically because `main` is pull-request-only; CI validates like any other PR. Merge on green."]);
  git(["fetch", "-q", "origin", "main"]);
  git(["reset", "-q", "--hard", "origin/main"]);
  return { committed: true, pushed: false, sha, via: "pr-open", url };
}

module.exports = { git, gh, commitAndPush };
