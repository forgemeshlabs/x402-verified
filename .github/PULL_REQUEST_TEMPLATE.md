## Seller

**What:** <seller name>, <endpoint URL>, <price per call>
**Why it belongs here:** <one sentence>

## Checklist

- [ ] This PR adds or changes exactly one file: `sellers/<slug>.json`
- [ ] Every listed endpoint answers HTTP 402 with a valid x402 envelope to the declared method
- [ ] `payTo` in the file matches `accepts[].payTo` in the live 402 envelope, and I control that wallet
- [ ] `proof.tx_hash` is a Base USDC transfer to that `payTo`, at least the route price, within the last 30 days
- [ ] No URL shorteners; homepage and endpoints share a domain
- [ ] I have read CONTRIBUTING.md and understand that the score, the `$` mark, and the `★` mark are independent and that ForgeMesh Paid is earned, never requested

Proof transaction: https://basescan.org/tx/<hash>
