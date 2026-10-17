# HeatVote Campaign Coordinator

Coordinates ecosystem votes for **Matchday** (project 597) on BOT Chain Mainnet
(chain 677). One long-running service, an on-chain cooldown-aware scheduler, and
encrypted-at-rest wallet credentials.

## How it works
- Reads each wallet's `nextVoteAt` from the HeatVote contract — never wall-clock math.
- Simulates (`staticCall` + `estimateGas`) before ever signing.
- Signs legacy EIP-155 transactions locally; keys exist decrypted only in memory.
- Decodes the `Vote` event from every receipt and verifies project ID + voter address.
- Never blindly resends after a timeout — chain state reconciles on the next tick.
- Pauses automatically at budget cap or campaign deadline.

## Setup
1. `npm install`
2. `cp .env.example .env` and fill in secrets (or set them in Railway):
   - `FUNDER_PRIVATE_KEY` — the distributor wallet
   - `VAULT_KEY` — `openssl rand -base64 32`

See **[OVERVIEW.md](OVERVIEW.md)** for a full walkthrough of every module, the safety
invariants, the fee-budget cap, failure modes, and the known loose ends.

## Usage
```bash
npm run check          # read-only chain sanity check
npm run init -- 1     # acceptance test: 1 wallet
npm run fund          # distribute PER_WALLET_ALLOCATION to unfunded wallets
npm start             # run the scheduler + /status endpoint
npm run report        # on-chain vs leaderboard reconciliation
npm run status        # local: pause/resume/inspect
```

## Files
| Path | Role |
|---|---|
| `src/scheduler.js` | Main loop; boot-time contract safety gates |
| `src/voter.js` | One vote cycle: eligibility → sim → sign → verify event |
| `src/fund.js` | Funder distribution with reserve check |
| `src/crypto.js` | AES-256-GCM key vault |

## Safety
- Private keys: only as ciphertext in SQLite on a persistent volume.
- `PROJECT_ID` verified against the official BOT Chain project API at boot.
- One pending transaction per wallet, enforced via on-chain cooldown reads.
- Kill switch: `campaign.paused=1` or `BUDGET_CAP_BOT` in the DB.

## Deploy notes
- On Railway, attach a volume mounted at `/data` (dashboard → service → Volumes)
  so `DB_PATH=/data/campaign.db` survives redeploys.
- Set `FUNDER_PRIVATE_KEY` and `VAULT_KEY` as service variables, never in git.
