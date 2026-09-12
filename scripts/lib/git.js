"use strict";
const { execFileSync } = require("node:child_process");
const { ROOT } = require("./sellers");

function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}

// Plain commit messages only: the operator's global commit-msg hook rejects AI attribution trailers.
function commitAndPush(paths, message, { push = true } = {}) {
  git(["add", "--", ...paths]);
  const staged = git(["diff", "--cached", "--name-only"]);
  if (!staged) return { committed: false, pushed: false };
  git(["-c", "user.name=x402-verified-bot", "-c", "user.email=hello@forgemesh.io", "commit", "-q", "-m", message]);
  if (push) git(["push", "-q", "origin", "HEAD:main"]);
  return { committed: true, pushed: push, sha: git(["rev-parse", "--short", "HEAD"]) };
}

module.exports = { git, commitAndPush };
