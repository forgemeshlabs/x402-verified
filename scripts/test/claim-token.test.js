"use strict";
// Claim token discovery: where a token may be published and, above all, where it may NOT.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const probe = require("../lib/probe");

const TOKEN = "forgemesh-claim-" + "a".repeat(24);
const seller = (overrides = {}) => ({ homepage: "https://svc.example", claim: { token: TOKEN, ownership: "manifest-token" }, ...overrides });

function withPages(pages, fn) {
  const orig = probe.fetchText;
  probe.fetchText = async (u) => (u in pages ? pages[u] : null);
  delete require.cache[require.resolve("../validate.js")];
  try { return fn(require("../validate.js")); } finally { probe.fetchText = orig; }
}

test("token in the origin's manifest or llms.txt counts", async () => {
  await withPages({ "https://svc.example/llms.txt": `# svc\n${TOKEN}\n` }, async ({ tokenPublished }) => {
    assert.equal(await tokenPublished(seller()), "https://svc.example/llms.txt");
  });
});

test("token in a repo the origin links to counts only when the README names the origin back", async () => {
  const pages = {
    "https://svc.example/llms.txt": "source: https://github.com/acme/svc\n",
    "https://raw.githubusercontent.com/acme/svc/main/README.md": `# svc\nLive at https://svc.example\n${TOKEN}\n`,
  };
  await withPages(pages, async ({ tokenPublished }) => {
    assert.equal(await tokenPublished(seller()), "https://raw.githubusercontent.com/acme/svc/main/README.md");
  });
});

test("a merely referenced repo (dependency, template) can never prove ownership", async () => {
  const pages = {
    "https://svc.example/llms.txt": "built with https://github.com/upstream/sdk\n",
    "https://raw.githubusercontent.com/upstream/sdk/main/README.md": `# sdk\n${TOKEN}\n`, // token there, but no mention of svc.example
    "https://raw.githubusercontent.com/upstream/sdk/main/.forgemesh-claim": TOKEN,
  };
  await withPages(pages, async ({ tokenPublished }) => {
    assert.equal(await tokenPublished(seller()), null);
  });
});

test("a malformed token never matches anything", async () => {
  await withPages({ "https://svc.example/llms.txt": "x" }, async ({ tokenPublished }) => {
    assert.equal(await tokenPublished(seller({ claim: { token: "x", ownership: "manifest-token" } })), null);
  });
});
