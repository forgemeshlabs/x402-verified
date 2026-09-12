"use strict";
// ForgeMesh Verified Score, x402 rubric v2.0. Pure function of published facts; anyone can
// recompute it from dist/verified.json. Zero points depend on ForgeMesh choosing to transact.
// MPP and additional networks are recorded as DETECTED capabilities and never scored here.
const { usdcToAtomic, USDC } = require("../receipt");

const SPEC = "2.0";
const BANDS = [
  { min: 85, band: "excellent" },
  { min: 70, band: "ready" },
  { min: 50, band: "friction" },
  { min: 0, band: "at-risk" },
];

function latencyPoints(ms) {
  if (ms == null) return 0;
  if (ms < 1000) return 6;
  if (ms < 3000) return 4;
  if (ms < 8000) return 2;
  return 0;
}

const CAIP2 = /^[a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

// Every accepts[] entry on every endpoint: scheme exact, CAIP-2 network, canonical USDC for
// that network when we know it, amount equal to the declared price.
function acceptsWellFormed(seller, run) {
  return run.endpoints.every((r, i) => {
    if (!r.accepts.length) return false;
    const declared = usdcToAtomic(seller.endpoints[i].price_usdc);
    return r.accepts.every((a) => {
      if (a.scheme !== "exact") return false;
      if (!CAIP2.test(String(a.network || ""))) return false;
      const canon = USDC[a.network];
      if (canon && String(a.asset || "").toLowerCase() !== canon) return false;
      if (!/^[0-9]+$/.test(String(a.amount || ""))) return false;
      return String(a.amount) === declared;
    });
  });
}

function score(seller, state) {
  const runs = (state.probes || []).slice(-8);
  const latest = runs[runs.length - 1] || null;
  const details = [];
  const add = (dim, pts, ok, label) => {
    details.push({ dimension: dim, points: ok ? pts : 0, max: pts, check: label, ok: !!ok });
    return ok ? pts : 0;
  };

  let payability = 0;
  payability += add("payability", 10, latest?.is_402, "every declared endpoint answers HTTP 402");
  payability += add("payability", 10, latest?.envelope_valid, "every 402 carries a valid x402 envelope");
  payability += add("payability", 5, latest?.payto_match, "envelope payTo matches the declared payTo");
  payability += add("payability", 15, state.proof_check?.ok, "seller-supplied on-chain proof verified");

  let reliability = 0;
  const passes = runs.filter((r) => r.pass).length;
  const passPts = runs.length ? Math.round((14 * passes) / runs.length) : 0;
  details.push({ dimension: "reliability", points: passPts, max: 14, check: `${passes}/${runs.length} recent probe runs passed`, ok: passPts === 14 });
  reliability += passPts;
  const lat = latencyPoints(latest?.ms);
  details.push({ dimension: "reliability", points: lat, max: 6, check: `latest response ${latest?.ms ?? "n/a"} ms`, ok: lat === 6 });
  reliability += lat;

  let interoperability = 0;
  interoperability += add("interoperability", 5, latest?.x402_version_2, "envelope declares x402Version 2");
  interoperability += add("interoperability", 5, latest?.header_envelope, "envelope delivered in the payment-required header");
  interoperability += add("interoperability", 5, latest?.body_envelope, "envelope also present in the JSON body (stock v1 clients)");
  interoperability += add("interoperability", 5, latest ? acceptsWellFormed(seller, latest) : false, "accepts[] entries well-formed: exact scheme, CAIP-2 network, canonical USDC, amount = declared price");

  let discoverability = 0;
  discoverability += add("discoverability", 6, latest?.manifest_ok, "/.well-known/x402 manifest present");
  discoverability += add("discoverability", 5, latest?.manifest_lists_route, "manifest names every declared route");
  discoverability += add("discoverability", 4, latest?.llms_ok, "llms.txt present");
  discoverability += add("discoverability", 5, state.bazaar_listed, "listed in the CDP Bazaar");

  const total = payability + reliability + interoperability + discoverability;
  const band = BANDS.find((b) => total >= b.min).band;
  return {
    spec: SPEC,
    score: total,
    band,
    perfect: total === 100,
    dimensions: { payability, reliability, interoperability, discoverability },
    details,
    computed_at: new Date().toISOString(),
  };
}

module.exports = { SPEC, BANDS, score, acceptsWellFormed, latencyPoints };
