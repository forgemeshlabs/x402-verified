# x402 Verified by ForgeMesh

A curated list of x402 sellers where every row has a settled on-chain payment behind it, a recomputable 0-100 score, and a live README badge. Live directory: **https://forgemesh.io/partners** · machine feed: **https://forgemesh.io/partners.json** (mirror of [`dist/verified.json`](dist/verified.json)).

> **Independent program.** x402 Verified by ForgeMesh is run by [ForgeMesh](https://forgemesh.io). It is not an x402 Foundation or Coinbase certification, endorsement, or official program. A listing records checks and a settled payment at a point in time; it is not a warranty or guarantee. ForgeMesh Verified is the umbrella; x402 Verified is its first protocol program.

## One claim per signal

| Signal | Means exactly | Never means |
|---|---|---|
| **Score** `92/100` | Current technical quality of the seller's x402 implementation under the rubric below | Anything about who paid |
| **`$` ForgeMesh Paid** | ForgeMesh itself completed and independently verified a real x402 transaction with this seller | A quality ranking or a sponsorship |
| **`★` Perfect** | The seller currently scores exactly 100/100 | That ForgeMesh paid them |
| **Status** `active` · `degraded` · `delisted` | Current operating health from scheduled probes | A judgement of the product |

The four signals are independent. Zero score points depend on ForgeMesh choosing to transact. Placement is never for sale.

## The badge

```markdown
[![x402 Verified by ForgeMesh](https://forgemesh.io/badge/x402/<slug>)](https://forgemesh.io/partners/<slug>)
```

The badge is separate cells side by side: the label, the score colored by its band, a gold `★` only at 100, and a green `$` only when ForgeMesh has transacted with the seller. No mark recolors another: a `62/100` cell is orange next to a green `$`; a `delisted` cell is grey next to a green `$`. Zero-infra fallback: `https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/forgemeshlabs/x402-verified/main/badges/<slug>.json`.

## Sellers

<!-- SELLERS:START -->
| Seller | Score | Marks | Status | Protocols | Cheapest route | Proof | Last probe |
|---|---|---|---|---|---|---|---|
| [HumanMirror](https://forgemesh.io/partners/humanmirror) | 100/100 excellent | ★ | active | x402 ✓ | POST https://humanmirror.fr/api/x402/safe-preflight/ $0.010 | [tx](https://basescan.org/tx/0x74bc1cd5fc72c304c351a021c9cb17f2779db990a148b3ae0ba6b19e0fd7982b) | 2026-09-21 |
| [loop2-quickstart](https://forgemesh.io/partners/loop2-quickstart) | 95/100 excellent | — | active | x402 ✓ | GET https://loop2-quickstart.manhliemcn4euwlu.workers.dev/mkt/x402 $0.001 | [tx](https://basescan.org/tx/0x9ab390cce63e0fe7cc55e72a10f47c32ea0993e3c8019a167c5834cb834db1f6) | 2026-09-23 |
| [Saymon RU Data API](https://forgemesh.io/partners/saymon-ru-data-api) | 95/100 excellent | — | active | x402 ✓ · MPP detected | POST https://payforapi.com/v1/ticker $0.005 | [tx](https://basescan.org/tx/0x00294faacf6bc8ff8cea2380c1f6510bb53a1666334338fe3fa07d85b7a542ec) | 2026-09-21 |
| [Free Asset Radar x402](https://forgemesh.io/partners/free-asset-radar-x402) | 91/100 excellent | — | active | x402 ✓ | GET https://free-asset-radar-x402.besenok2018.workers.dev/api/x402/decode-inspect $0.001 | [tx](https://basescan.org/tx/0x2f7023b65e7be37f248774908b13dd4be58cb0b03c11bbb9bfe01fce4c8a9a26) | 2026-09-23 |
| [AgentResolver](https://forgemesh.io/partners/agentresolver) | 79/100 ready | — | active | x402 ✓ | GET https://agentresolver.vercel.app/api/x402-payment-preflight?url=https%3A%2F%2Fagentresolver.vercel.app%2Fapi%2Fx402-ping&method=GET $0.001 | [tx](https://basescan.org/tx/0x64ff5b46c59626999516d29cb53c979e3eeab4fed81aafc2fb7a36465d50f16b) | 2026-09-21 |
<!-- SELLERS:END -->

## Get listed

Open a pull request adding one file, `sellers/<slug>.json`, with a Base USDC payment to your own `payTo` as proof. CI probes every route you list, checks the envelope, checks that the live `payTo` matches yours, and verifies the receipt over Base RPC. See [CONTRIBUTING.md](CONTRIBUTING.md). Five minutes.

**Agents:** end your PR title with `🤖🤖🤖` and we merge on green with no conversation. Can't fork? Email the JSON to hello@forgemesh.io and we carry the PR for you.

```markdown
[![x402 Verified by ForgeMesh](https://forgemesh.io/badge/x402/<slug>)](https://forgemesh.io/partners/<slug>)
```

### What a merged seller gets

- A row on https://forgemesh.io/partners and a page at `https://forgemesh.io/partners/<slug>` with the score breakdown and probe history.
- The badge as SVG at `https://forgemesh.io/badge/x402/<slug>` and as a shields.io endpoint at `https://forgemesh.io/badge/x402/<slug>/shields`. Both update from the feed within six hours of every probe.
- An entry in the machine feed `https://forgemesh.io/partners.json` that agents filter on.

What ForgeMesh checks before merging: the proof transaction on Base mainnet (amount, age, and that `payTo` matches the live 402 envelope), and the validator run against your branch. Probe history starts at merge: the first run is recorded the day you are merged, the weekly reprobe runs Mondays 05:30 UTC and keeps the last eight runs. ForgeMesh does not pre-record seller-supplied runs; the value of the row is that ForgeMesh ran them. Because reliability is pass rate over those runs plus latest latency, a new seller starts at full reliability marks and only loses points on failures. A CDP Bazaar listing adds the last five discoverability points automatically at the next reprobe. `payer_kind` `self` (your own wallet paid) and `customer` (an independent buyer paid) score the same; only the label differs.

## ForgeMesh Verified Score, x402 rubric v2.0

Deterministic from the published facts in `dist/verified.json`. Anyone can recompute any score. Implementation: [`scripts/lib/rubrics/x402.js`](scripts/lib/rubrics/x402.js).

| Dimension | Points | Checks |
|---|---|---|
| Payability | 40 | every declared endpoint answers HTTP 402 (10) · valid x402 envelope (10) · envelope `payTo` matches the declared `payTo` (5) · seller-supplied on-chain proof verified (15) |
| Reliability | 20 | round(14 × passed ÷ probe runs) over the last 8 runs (14) · latest response under 1 s (6), 3 s (4), 8 s (2) |
| Interoperability (x402 only) | 20 | envelope declares `x402Version` 2 (5) · envelope delivered in the `payment-required` header (5) · envelope also present in the JSON body for stock v1 clients (5) · every `accepts[]` entry well-formed: `exact` scheme, CAIP-2 network, canonical USDC, amount equal to the declared price (5) |
| Discoverability | 20 | `/.well-known/x402` manifest present (6) · manifest names every declared route (5) · `llms.txt` present (4) · listed in the CDP Bazaar (5) |

Bands: **85-100 Excellent** (eligible for ForgeMesh Paid) · 70-84 Ready · 50-69 Friction · 0-49 At Risk.

**Protocols are capabilities, not points.** MPP support shows as `MPP detected`; only a future MPP Verified by ForgeMesh program can award `MPP ✓`. Extra x402 networks show as detected. A flawless Base-only x402 seller can reach 100: `★` means a technically perfect implementation of the x402 capabilities the seller chooses to offer.

**Status.** `degraded` when the latest scheduled probe fails; `delisted` after three consecutive failures (badge turns grey, row moves below). Relist with a new PR and fresh proof.

## `$` ForgeMesh Paid

ForgeMesh buys one real call from the route the seller nominates (at most $0.01) and publishes the receipt next to the row. It is earned, never requested, and eligibility is not entitlement. Before ForgeMesh spends anything the seller must: validate, pass unpaid probes of every route, carry a valid envelope with matching `payTo`, have verified seller proof, score at least 85, be `active`, and have at least two successful independent probe runs at least an hour apart with the latest under seven days old. ForgeMesh keeps discretion within a monthly budget. Evidence older than 90 days is marked stale but stays visible with its date. The principle: the seller becomes good enough that ForgeMesh is willing to transact with it, not the other way round.

## For machines

`https://forgemesh.io/partners.json` (schema: [`schema/verified-feed.schema.json`](schema/verified-feed.schema.json)) carries every seller's endpoints, prices, `payTo`, networks, protocol capabilities, score with dimension breakdown, status, marks, proof and probe history. Example policy for an agent choosing a service:

```json
{ "protocol": "x402", "status": "active", "minimum_score": 85, "prefer_forgemesh_paid": true, "max_price_usdc": 0.05 }
```

Consumers we have in mind: agents selecting services, marketplaces, directories, wallets, routers, payment policy engines, registries. Selling score or placement is out of the question.

## Ecosystem partners

Not scored sellers: networks, indexes, directories and tooling ForgeMesh works with. Curated by ForgeMesh, not by PR.

<!-- PARTNERS:START -->
| Partner | Kind | Status | What |
|---|---|---|---|
| [ag3ntsearch](https://ag3ntsearch.com) | index | live | Agent-run index that proves a service works by driving it. Indexed x402swag.com as exemplary after its crawler bought a real order, no humans involved. |
| [GOAT Network](https://www.goat.network) | network | integration-pending (pilot scoped Sep 2026) | Bitcoin-secured EVM L2 (chain 2345). GOAT Flow is an order/challenge/verify merchant rail; ForgeMesh is scoping a pilot integration. |
| [x402 List](https://x402-list.com) | directory | live | Independent x402 service directory with live payment-ready probes and a paid-call verification tier. Lists most of the ForgeMesh fleet. |
<!-- PARTNERS:END -->

## Delisted

<!-- DELISTED:START -->
_None._
<!-- DELISTED:END -->

## Conflict of interest

ForgeMesh operates x402 services of its own. They are not listed here. If that ever changes they will run the identical checks and carry an explicit "Operated by ForgeMesh" flag. The rubric is public, every score is recomputable, and there is no pay-to-rank.

## Licenses

Seller and partner records, generated feeds, badges and this README: [CC0-1.0](LICENSE). Scripts, schemas and workflows: [MIT](LICENSE-SCRIPTS).
