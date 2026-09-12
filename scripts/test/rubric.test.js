"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { score } = require("../lib/rubrics/x402");
const { compute, statusFrom } = require("../lib/score");

const seller = {
  slug: "fixture", name: "Fixture", homepage: "https://fixture.example", protocols: ["x402"], payTo: "0x48096526488f2D51df6bcA1B1f3A3639986cc3dD",
  endpoints: [{ url: "https://fixture.example/api/x402/one/", method: "POST", price_usdc: "0.010" }],
  networks: ["eip155:8453"], proof: { tx_hash: "0x" + "1".repeat(64), endpoint: 0, payer_kind: "self" },
};
const perfectEndpoint = {
  is_402: true, envelope_valid: true, header_envelope: true, body_envelope: true, x402_version: 2, mpp_header: false, response_time_ms: 400,
  accepts: [{ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: seller.payTo, amount: "10000" }],
};
const perfectRun = (over = {}) => ({
  at: "2026-09-12T00:00:00.000Z", endpoints: [perfectEndpoint], is_402: true, envelope_valid: true, payto_match: true, header_envelope: true, body_envelope: true,
  x402_version_2: true, mpp_header: false, ms: 400, manifest_ok: true, manifest_lists_route: true, llms_ok: true, networks_detected: ["eip155:8453"], pass: true, ...over,
});
const perfectState = () => ({ probes: [perfectRun()], proof_check: { ok: true }, bazaar_listed: true, forgemesh_paid: null });

test("a Base-only single-protocol seller can score 100", () => {
  const s = score(seller, perfectState());
  assert.equal(s.score, 100);
  assert.equal(s.perfect, true);
  assert.deepEqual(s.dimensions, { payability: 40, reliability: 20, interoperability: 20, discoverability: 20 });
});

test("an MPP header changes nothing in the score; it is only detected", () => {
  const withMpp = perfectState(); withMpp.probes[0].mpp_header = true;
  assert.equal(score(seller, withMpp).score, 100);
  const c = compute(seller, withMpp);
  assert.equal(c.protocol_capabilities.mpp.supported, true);
  assert.equal(c.protocol_capabilities.mpp.verified, false);
});

test("extra x402 networks are detected, not scored", () => {
  const st = perfectState(); st.probes[0].networks_detected = ["eip155:8453", "eip155:1"];
  assert.equal(score(seller, st).score, 100);
  assert.deepEqual(compute(seller, st).networks_detected, ["eip155:8453", "eip155:1"]);
});

test("ForgeMesh Paid adds zero points and is an independent mark", () => {
  const st = perfectState(); st.forgemesh_paid = { tx_hash: "0x" + "2".repeat(64), paid_at: new Date().toISOString(), amount_atomic: "10000" };
  const c = compute(seller, st);
  assert.equal(c.score, 100);
  assert.equal(c.forgemesh_paid, true);
  assert.equal(c.forgemesh_paid_stale, false);
  st.forgemesh_paid.paid_at = "2026-01-01T00:00:00.000Z";
  assert.equal(compute(seller, st).forgemesh_paid_stale, true);
});

test("reliability uses real passes over probes with one probe earning full credit", () => {
  const one = perfectState();
  assert.equal(score(seller, one).dimensions.reliability, 20);
  const half = perfectState(); half.probes = [perfectRun({ pass: false }), perfectRun()];
  assert.equal(score(seller, half).dimensions.reliability, 7 + 6);
});

test("latency bands", () => {
  for (const [ms, pts] of [[400, 6], [2000, 4], [5000, 2], [9000, 0]]) {
    const st = perfectState(); st.probes[0].ms = ms;
    assert.equal(score(seller, st).dimensions.reliability, 14 + pts, `ms=${ms}`);
  }
});

test("well-formed accepts requires exact scheme, CAIP-2, canonical USDC and declared amount", () => {
  const bad = perfectState(); bad.probes[0].endpoints = [{ ...perfectEndpoint, accepts: [{ ...perfectEndpoint.accepts[0], amount: "20000" }] }];
  assert.equal(score(seller, bad).dimensions.interoperability, 15);
  const badAsset = perfectState(); badAsset.probes[0].endpoints = [{ ...perfectEndpoint, accepts: [{ ...perfectEndpoint.accepts[0], asset: "0x" + "9".repeat(40) }] }];
  assert.equal(score(seller, badAsset).dimensions.interoperability, 15);
});

test("bands and status", () => {
  const st = perfectState(); st.proof_check = { ok: false }; st.bazaar_listed = false; st.probes[0].body_envelope = false;
  const s = score(seller, st); // 100 - 15 - 5 - 5 = 75
  assert.equal(s.score, 75); assert.equal(s.band, "ready"); assert.equal(s.perfect, false);
  assert.equal(statusFrom([perfectRun()]), "active");
  assert.equal(statusFrom([perfectRun(), perfectRun({ pass: false })]), "degraded");
  assert.equal(statusFrom([perfectRun({ pass: false }), perfectRun({ pass: false }), perfectRun({ pass: false })]), "delisted");
  assert.equal(statusFrom([perfectRun({ pass: false }), perfectRun({ pass: false }), perfectRun()]), "active");
});
