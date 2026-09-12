"use strict";
// Runs a protocol rubric and derives the independent marks. Rubrics are plugins so a future
// MPP Verified program can reuse probe/receipt/build unchanged.
const rubrics = { x402: require("./rubrics/x402") };

const PAID_STALE_DAYS = 90;

function statusFrom(runs) {
  const recent = (runs || []).slice(-3);
  if (!recent.length) return "active";
  const latest = recent[recent.length - 1];
  if (recent.length >= 3 && recent.every((r) => !r.pass)) return "delisted";
  return latest.pass ? "active" : "degraded";
}

function protocolCapabilities(state) {
  const latest = (state.probes || []).slice(-1)[0];
  return {
    x402: { supported: !!latest?.is_402, verified: !!(latest?.is_402 && latest?.envelope_valid), version: latest?.x402_version_2 ? 2 : (latest?.endpoints?.[0]?.x402_version ?? null) },
    mpp: { supported: !!latest?.mpp_header, verified: false, note: "detected only; MPP Verified by ForgeMesh is a separate future program" },
  };
}

function compute(seller, state, program = "x402") {
  const rubric = rubrics[program];
  if (!rubric) throw new Error(`unknown rubric ${program}`);
  const s = rubric.score(seller, state);
  const paidAt = state.forgemesh_paid?.paid_at || null;
  const stale = paidAt ? Date.now() - Date.parse(paidAt) > PAID_STALE_DAYS * 86400000 : false;
  const latest = (state.probes || []).slice(-1)[0];
  return {
    score: s.score,
    score_band: s.band,
    dimensions: s.dimensions,
    score_details: s.details,
    score_spec: s.spec,
    perfect: s.perfect,
    status: state.status_override || statusFrom(state.probes),
    forgemesh_paid: !!state.forgemesh_paid?.tx_hash,
    forgemesh_paid_at: paidAt,
    forgemesh_paid_tx: state.forgemesh_paid?.tx_hash || null,
    forgemesh_paid_amount_atomic: state.forgemesh_paid?.amount_atomic || null,
    forgemesh_paid_stale: stale,
    protocol_capabilities: protocolCapabilities(state),
    networks_detected: latest?.networks_detected || [],
    last_probe: latest?.at || null,
    computed_at: s.computed_at,
  };
}

module.exports = { compute, statusFrom, rubrics, PAID_STALE_DAYS };
