"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { staticErrors, registrableDomain } = require("../lib/sellers");
const { usdcToAtomic } = require("../lib/receipt");

const good = () => ({ file: "/x/sellers/good-api.json", data: {
  name: "Good API", slug: "good-api", homepage: "https://good.example", description: "Does a useful thing for agents.", protocols: ["x402"],
  endpoints: [{ url: "https://good.example/api/x402/one/", method: "POST", price_usdc: "0.010" }], nominated_endpoint: 0,
  payTo: "0x48096526488f2D51df6bcA1B1f3A3639986cc3dD", networks: ["eip155:8453"], contact: "mailto:a@good.example",
  proof: { tx_hash: "0x" + "a".repeat(64), endpoint: 0, payer_kind: "self" }, added_at: "2026-09-12" } });

test("a valid record has no static errors", () => assert.deepEqual(staticErrors(good(), [good()]), []));
test("filename must match slug", () => { const g = good(); g.file = "/x/sellers/other.json"; assert.match(staticErrors(g, []).join(";"), /filename must be good-api.json/); });
test("shorteners are refused", () => { const g = good(); g.data.homepage = "https://bit.ly/abc"; assert.match(staticErrors(g, []).join(";"), /shorteners|not on the homepage domain/); });
test("nominated route price is capped at $0.01", () => { const g = good(); g.data.endpoints[0].price_usdc = "0.020"; assert.match(staticErrors(g, []).join(";"), /exceeds the \$0.01 cap/); });
test("duplicate payTo and proof tx across sellers are refused", () => {
  const g = good(); const o = good(); o.file = "/x/sellers/other-api.json"; o.data.slug = "other-api"; o.data.homepage = "https://other.example"; o.data.endpoints[0].url = "https://other.example/api/x402/one/";
  const errs = staticErrors(g, [g, o]).join(";");
  assert.match(errs, /payTo already used by other-api/); assert.match(errs, /proof tx already used by other-api/);
});
test("registrable domain handles two-part TLDs", () => { assert.equal(registrableDomain("api.shop.co.uk"), "shop.co.uk"); assert.equal(registrableDomain("humanmirror.fr"), "humanmirror.fr"); });
test("usdc to atomic", () => { assert.equal(usdcToAtomic("0.010"), "10000"); assert.equal(usdcToAtomic("1"), "1000000"); assert.equal(usdcToAtomic("0.000001"), "1"); });
