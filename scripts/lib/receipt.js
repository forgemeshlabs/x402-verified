"use strict";
// Zero-dependency Base JSON-RPC receipt check. Never uses Blockscout (operator rule 2026-09-01).
const RPCS = [process.env.BASE_RPC_URL, "https://mainnet.base.org", "https://base-rpc.publicnode.com"].filter(Boolean);
const USDC = { "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" };
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function rpc(method, params) {
  let lastErr;
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "x402-verified/2.0" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(10000),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || "rpc error");
      return json.result;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`all Base RPCs failed for ${method}: ${lastErr?.message}`);
}

const pad = (addr) => "0x" + "0".repeat(24) + addr.toLowerCase().slice(2);
const unpad = (topic) => "0x" + topic.slice(-40);

// Verify that txHash contains a USDC Transfer log TO payTo for at least minAmountAtomic.
async function verifyUsdcTransfer({ txHash, payTo, minAmountAtomic, network = "eip155:8453", maxAgeDays = null, minConfirmations = 10 }) {
  const out = { ok: false, reason: null, tx_hash: txHash, block: null, block_time: null, amount_atomic: null, payer: null, confirmations: null, checked_at: new Date().toISOString() };
  const usdc = USDC[network];
  if (!usdc) { out.reason = `no canonical USDC known for ${network}`; return out; }
  const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
  if (!receipt) { out.reason = "transaction not found on Base"; return out; }
  if (receipt.status !== "0x1") { out.reason = "transaction reverted"; return out; }
  const want = pad(payTo);
  const hits = (receipt.logs || []).filter((l) =>
    String(l.address).toLowerCase() === usdc &&
    (l.topics?.[0] || "").toLowerCase() === TRANSFER_TOPIC &&
    (l.topics?.[2] || "").toLowerCase() === want);
  if (!hits.length) { out.reason = `no USDC Transfer to ${payTo} in this transaction`; return out; }
  const best = hits.reduce((a, b) => (BigInt(a.data) >= BigInt(b.data) ? a : b));
  const amount = BigInt(best.data);
  out.amount_atomic = amount.toString();
  out.payer = unpad(best.topics[1]);
  out.block = parseInt(receipt.blockNumber, 16);
  if (amount < BigInt(minAmountAtomic)) { out.reason = `transfer of ${amount} atomic is below the required ${minAmountAtomic}`; return out; }
  const head = parseInt(await rpc("eth_blockNumber", []), 16);
  out.confirmations = head - out.block;
  if (out.confirmations < minConfirmations) { out.reason = `only ${out.confirmations} confirmations (need ${minConfirmations})`; return out; }
  const block = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
  const ts = parseInt(block.timestamp, 16);
  out.block_time = new Date(ts * 1000).toISOString();
  if (maxAgeDays != null && Date.now() / 1000 - ts > maxAgeDays * 86400) {
    out.reason = `transaction is older than ${maxAgeDays} days`; return out;
  }
  out.ok = true;
  return out;
}

function usdcToAtomic(priceUsdc) {
  const [whole, frac = ""] = String(priceUsdc).split(".");
  return (BigInt(whole || "0") * 1000000n + BigInt((frac + "000000").slice(0, 6))).toString();
}

module.exports = { rpc, verifyUsdcTransfer, usdcToAtomic, USDC, TRANSFER_TOPIC };
