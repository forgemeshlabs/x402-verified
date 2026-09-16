#!/usr/bin/env node
"use strict";
// Regenerate README/dist/badges and publish them (opens a PR when main is protected; a maintainer merges).
// Run after any seller merge and from cron before the site's verified-sync.
//   node scripts/publish-build.js
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { commitAndPush, git } = require("./lib/git");
git(["pull", "-q", "--ff-only", "origin", "main"]);
execFileSync(process.execPath, [path.join(__dirname, "build.js")], { stdio: "inherit" });
const r = commitAndPush(["README.md", "dist", "badges"], `Build ${new Date().toISOString().slice(0, 10)}: regenerate feed, badges, README`);
console.log(r.committed ? `${r.via}: ${r.sha}${r.url ? " " + r.url : ""}` : "nothing to publish");
