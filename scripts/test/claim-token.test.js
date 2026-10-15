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
    "https://svc.example/.well-known/x402": JSON.stringify({ name: "svc", repository: "https://github.com/acme/svc" }),
    "https://raw.githubusercontent.com/acme/svc/main/README.md": `# svc\nLive at https://svc.example\n${TOKEN}\n`,
  };
  await withPages(pages, async ({ tokenPublished }) => {
    assert.equal(await tokenPublished(seller()), "https://raw.githubusercontent.com/acme/svc/main/README.md");
  });
});

test("a merely referenced repo (dependency, template, awesome list) can never prove ownership", async () => {
  const pages = {
    // free-text link in llms.txt, and a manifest that mentions a repo outside a repository field
    "https://svc.example/llms.txt": "built with https://github.com/upstream/sdk\n",
    "https://svc.example/.well-known/x402": JSON.stringify({ name: "svc", description: "listed in https://github.com/lists/awesome-x402" }),
    "https://raw.githubusercontent.com/upstream/sdk/main/README.md": `# sdk\nUsed by https://svc.example\n${TOKEN}\n`, // even names the host
    "https://raw.githubusercontent.com/upstream/sdk/main/.forgemesh-claim": TOKEN,
    "https://raw.githubusercontent.com/lists/awesome-x402/main/README.md": `# awesome\n- https://svc.example\n${TOKEN}\n`,
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

test("a declared repo whose README does not name the origin back is rejected", async () => {
  const pages = {
    "https://svc.example/.well-known/x402": JSON.stringify({ repository: { url: "https://github.com/acme/svc.git" } }),
    "https://raw.githubusercontent.com/acme/svc/main/README.md": `# svc\n${TOKEN}\n`,
  };
  await withPages(pages, async ({ tokenPublished, declaredRepos }) => {
    assert.deepEqual(declaredRepos(pages["https://svc.example/.well-known/x402"]), ["acme/svc"]);
    assert.equal(await tokenPublished(seller()), null);
  });
});
