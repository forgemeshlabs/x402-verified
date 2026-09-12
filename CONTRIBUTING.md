# Contributing a seller

One pull request adds one file: `sellers/<slug>.json`. CI validates it with no secrets and no human in the loop; a maintainer merges when it is green.

## The file

```json
{
  "name": "Example API",
  "slug": "example-api",
  "homepage": "https://example.com",
  "description": "One line: what the paid routes do.",
  "protocols": ["x402"],
  "endpoints": [
    { "url": "https://example.com/api/x402/thing/", "method": "POST", "price_usdc": "0.010", "body": { "input": "sample" } }
  ],
  "nominated_endpoint": 0,
  "payTo": "0xYourWalletOnBase",
  "networks": ["eip155:8453"],
  "manifest": "https://example.com/.well-known/x402",
  "llms_txt": "https://example.com/llms.txt",
  "contact": "mailto:you@example.com",
  "proof": { "tx_hash": "0x...", "endpoint": 0, "payer_kind": "self" },
  "added_at": "2026-09-12"
}
```

`slug` must equal the filename. `method` is the verb that produces the 402 (many sellers answer 402 only on POST; declare it). `body` is an optional sample request body for POST routes. `nominated_endpoint` is the route ForgeMesh may buy from if the seller becomes eligible for `$`; it must cost at most $0.01. `manifest` and `llms_txt` default to `/.well-known/x402` and `/llms.txt` on the endpoint origin.

## Rules (CI enforces what it can)

1. One seller per PR; the PR touches only `sellers/<slug>.json`.
2. `proof.tx_hash` is a Base mainnet USDC transfer **to your `payTo`**, at least the route's price, at least 10 confirmations, at most 30 days old, and not used by any other seller. Any payer works; a payment you made yourself is fine.
3. You control `payTo`: the live 402 envelope's `accepts[].payTo` must equal the file's `payTo`, which must equal the transfer's recipient.
4. Every listed endpoint answers HTTP 402 with a valid x402 envelope to its declared method.
5. No URL shorteners. Homepage and endpoints share a registrable domain. No duplicate homepage domain or `payTo` across sellers.
6. Do not create new `/.well-known/*` paths for us. If you already publish `/.well-known/x402`, naming your routes there earns discoverability points.
7. Three consecutive failed weekly probes delist the row. Relist with a new PR and fresh proof.

## What you get

A row on https://forgemesh.io/partners, a page at `/partners/<slug>` with the score breakdown and probe history, and a badge:

```markdown
[![x402 Verified by ForgeMesh](https://forgemesh.io/badge/x402/<slug>)](https://forgemesh.io/partners/<slug>)
```

## The three marks are independent

The score measures your x402 implementation. `$` records that ForgeMesh itself transacted with you. `★` records a perfect 100. ForgeMesh Paid is earned, never requested: sellers at 85 or above, `active`, with two successful independent probe runs become eligible, and ForgeMesh decides when to buy within its budget. Asking for it does nothing.

## Ecosystem partners

`partners/*.json` is curated by ForgeMesh. Please do not open PRs against it.

## Running the checks locally

```bash
npm ci
node scripts/validate.js --slug <slug>
```
