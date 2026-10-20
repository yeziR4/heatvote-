# Code Overview — HeatVote Campaign Coordinator

Everything in this repository, what each piece does, how the safety mechanisms work,
and every loose end I know about. Written as engineering documentation, not a pitch.

**What the system is, plainly:** a long-running Node process that holds a fleet of
EOA wallets, each with its own key encrypted at rest, and casts one vote per wallet
every 6 hours for project 597 (`Matchday`) on BOT Chain mainnet (chain 677), within a
fee budget, with a kill switch and an HTTP status page.

---

## 1. Runtime shape

```
Railway container
├── npm start → node src/scheduler.js     ← the only long-running process
│   ├── boot gates (2 hard aborts)
│   ├── tick every 20s, max 3 votes in flight
│   └── HTTP /status on $PORT
└── /data/campaign.db                     ← SQLite on a mounted volume (WAL)

One-shot operators, run manually inside the container:
  init-wallets.js · fund.js · refill.js · check-fleet.js · fix-record.js · monitor.js · control.js
```

Two facts that matter operationally:

- **The database is a single point of failure.** `/data/campaign.db` holds the *only*
  copy of every wallet's encrypted private key. No volume, no wallets, no recovery —
  the chain will still hold the balances, but nothing can sign for them.
- **`VAULT_KEY` rotation is irreversible destruction.** Keys are stored only as
  AES-256-GCM ciphertext. Change the variable and every stored key becomes
  undecryptable. Funds are not lost on-chain, but they become unreachable by this code.

---

## 2. Component map

| File | Lines | Chain reads | Writes DB | Moves BOT | Role |
|---|---|---|---|---|---|
| `config.js` | 19 | — | — | — | Env → typed config object; exports `MIN_VOTE_FUNDING_WEI` |
| `crypto.js` | 23 | — | — | — | AES-256-GCM key vault; **throws at import** if `VAULT_KEY` isn't 32 b64 bytes |
| `db.js` | 54 | — | schema | — | Opens SQLite, WAL, busy_timeout; creates 4 tables; `kv` get/set helper |
| `provider.js` | 53 | heavy | — | — | RPC provider, `VOTE_ABI`, `readContract`, `makeSigner`, `funderWallet`, `chainTime`, `verifyProjectIdentity` |
| `voter.js` | 115 | heavy | yes | signs votes | `voteOnce()` — the entire vote cycle, steps 1–7 |
| `scheduler.js` | 111 | boot | yes | — | Boot gates, tick loop, `/status` endpoint |
| `init-wallets.js` | 32 | only in `0` mode | yes | — | Generates + encrypts N wallets; `0` = read-only chain sanity check |
| `fund.js` | 29 | balances | yes | **yes** | First funding pass — only wallets with `funder_tx_hash IS NULL` |
| `refill.js` | 40 | balances | yes | **yes** | Tops every wallet to `TARGET_TOPUP` from its real balance |
| `check-fleet.js` | 30 | balances | — | — | Read-only fleet health report |
| `fix-record.js` | 59 | receipts | yes | — | One-off reconciler for `failed`/`unverified` rows |
| `monitor.js` | 24 | project API | yes (`snapshots`) | — | Weekly/monthly board snapshot + divergence check |
| `control.js` | 16 | — | yes | — | `pause` / `resume` / `status` / `*-wallet` CLI |

Only `fund.js`, `refill.js`, and `voter.js` can move money. Everything else is read-only
or DB-local.

---

## 3. Data model

Four tables. The one that matters most is `votes`, because its `status` column is a
state machine the scheduler reads back:

```
                    ┌──────────► confirmed   (event verified: project + voter match)
                    │
pending ────────────┼──────────► failed      (tx reverted, or any throw before receipt)
  (inserted at      │
   broadcast)       ├──────────► timeout     (3 min with no receipt; chain reconciles next tick)
                    │
                    └──────────► unverified  (tx MINED, but event could not be verified)
```

- `wallets` — `address`, `encrypted_key`, `funder_tx_hash` (set on first funding only,
  via `COALESCE`), `funded_amount`, `status` (`active`/`paused`/`retired`),
  `consent_withdrawn`.
- `votes` — one row per broadcast tx; `next_eligible_at` is a **cache of the chain's
  `nextVoteAt`**, never a wall-clock guess.
- `campaign` — key/value; holds `paused` and `total_fees_bot`.
- `snapshots` — append-only leaderboard history from `monitor.js`.

`status='retired'` (with `consent_withdrawn=1`) is the only state the scheduler excludes
permanently. `paused` is temporary.

---

## 4. Safety invariants

These are the load-bearing design decisions. Each is enforced in code, not by convention.

1. **The chain is the only source of truth for eligibility.** `voter.js` re-reads
   `nextVoteAt`, `whitelist`, and the latest block timestamp on *every* attempt. The
   DB's `next_eligible_at` is only a cheap pre-filter.
2. **Simulate before signing.** `vote.staticCall(...)` then `estimateGas(...)` run first,
   both free. A revert or cooldown is caught there and never costs gas.
3. **Explorer event must prove ownership of the vote.** The receipt is scanned for a
   `Vote` log, decoded, and both `projectID === 597` and `voter === our address` must
   match. Args are read positionally (`args[0]`, `args[1]`) so an ABI rename can't
   silently resolve to `undefined`.
4. **Gas bounds.** `GAS_LIMIT_CAP = 80_000` (observed real votes: 38k–56k), 1.2× estimate
   buffer, price capped at `MAX_GAS_PRICE_GWEI`. Above the cap, the wallet is skipped,
   not sent.
5. **Balance floor before signing.** `MIN_VOTE_FUNDING_WEI` (0.002 BOT) and
   `gasLimit × gasPrice` must both be covered.
6. **One transaction per wallet at a time.** The `running` Set in `scheduler.js`.
7. **Never blind-resend.** On timeout the row is marked `timeout` and left alone; the
   next tick re-reads the chain. If the tx did land, `nextVoteAt` protects the wallet.
8. **Boot gates abort loudly.** `voteCooldown()` must equal `21600`; the public project
   API must return `projectId 597` + `projectName "Matchday"` + `status "live"`.
9. **Keys exist decrypted only in memory,** for the duration of one call, and are checked
   against the address (`key/address mismatch` throws).

---

## 5. The budget cap

**Where:** `config.js` → `budgetCapWei`, from `BUDGET_CAP_BOT` (default `1.04`).
**Enforced:** `scheduler.js:54-58`, first thing every tick, before any wallet loop.

```js
const feesSoFar = BigInt(kv.get("total_fees_bot") ?? "0");
if (feesSoFar >= cfg.budgetCapWei) { kv.set("paused","1"); return; }   // "BUDGET CAP — paused"
```

**What it counts:** only `rc.gasUsed × rc.gasPrice` from vote transactions — accumulated
in `campaign.total_fees_bot`, incremented on `confirmed` *and* on `unverified`
(`voter.js`). **What it does not count:** wallet allocations, funding/re-top-up transfers,
or gas burned by reverted txs.

**Arithmetic at the observed fee** (`0.00075648` BOT/vote):

| `BUDGET_CAP_BOT` | Vote fees before the cap trips |
|---|---|
| 1.04 (current) | `1.04 / 0.00075648` ≈ **1,375 votes** |
| 2.50 | ≈ 3,300 votes |
| 4.00 | ≈ 5,290 votes |

**Two nuances that cause real confusion:**

- **It is a pause, not a stop.** `npm run resume` clears `paused=1`, but the very next
  tick sees `feesSoFar >= cap` and immediately re-pauses. To actually continue, you must
  **raise `BUDGET_CAP_BOT`**. Editing the `paused` flag alone does nothing.
- **It was inert until the ABI fix.** Before `9b4a768`, `total_fees_bot` never
  incremented — the throw happened before the accounting line — so the cap could never
  have fired. It is live now.

The deadline (`CAMPAIGN_DEADLINE`) works the same way: past it the tick returns quietly,
no pause flag, no log spam.

---

## 6. Failure modes

| Scenario | Behaviour | Row status |
|---|---|---|
| Still in cooldown | Skip, no gas spent | none written |
| `staticCall` reverts | Skip with reason (`sim-revert: …`) | none written |
| Gas estimate > 80k | Skip (`gas-above-cap`) | none written |
| Balance below floor | Skip (`insufficient-balance`) | none written |
| Tx reverts on-chain | Throws, caught | `failed` |
| No receipt in 3 min | Warn, no resend | `timeout` |
| Mined, event doesn't verify | Fee recorded, error saved | `unverified` |
| Event verifies | Confirmed, fee + eligibility saved | `confirmed` |
| Fund cap reached | Whole campaign pauses | — |
| Funder can't cover refill | Aborts **before** sending anything | — |

Note: `failed` rows have `next_eligible_at = NULL`, so that wallet looks "due" every
tick and re-attempts (harmlessly skipped by the simulation) until the chain's cooldown
expires. `unverified` rows *do* store eligibility, so they don't churn.

---

## 7. Operational runbook

### Environment variables

| Variable | Default | Notes |
|---|---|---|
| `RPC_URL` | `https://rpc.botchain.ai` | |
| `CHAIN_ID` | `677` | static network, so wrong values fail fast |
| `VOTING_PROXY` | `0xF5b2…b181` | HeatVote proxy |
| `PROJECT_ID` | `597` | |
| `PER_WALLET_ALLOCATION` | `0.0085` | used by `fund.js` |
| `CAMPAIGN_DEADLINE` | `2026-10-18T16:00:00Z` | |
| `MAX_GAS_PRICE_GWEI` | `30` | hard ceiling per tx |
| `BUDGET_CAP_BOT` | `1.04` | see §5 |
| `TICK_SECONDS` | `20` | |
| `MAX_CONCURRENT_VOTES` | `3` | in-flight cap |
| `COOLDOWN_BUFFER_SECONDS` | `180` | safety margin on 21600 |
| `DB_PATH` | `/data/campaign.db` | must be on the volume |
| `PORT` | `8080` | `/status` |
| `TARGET_TOPUP` | `0.0085` | **`refill.js` only — undocumented in `.env.example`** |
| `FUNDER_PRIVATE_KEY` | — | **secret**, env only; primary funder |
| `FUNDER_PRIVATE_KEYS` | — | **secret**, extra funder keys, comma-separated; fund/refill split work across all of them, each keeps `DIST_RESERVE_WEI / n` |
| `REFILL_ON_BOOT` | unset | **boot.js only — run one refill pass on every start when set to `1`** |
| `VAULT_KEY` | — | **secret**, 32 bytes base64; rotation is destructive |

### Commands

```powershell
npm run check                 # read-only chain sanity (needs VAULT_KEY — imports crypto)
npm run init -- 3             # create 3 wallets (acceptance test)
npm run fund                  # first funding pass only
npm start                     # the scheduler
npm run report                # board snapshot + divergence check
npm run status                # paused flag, fee total, tables
node src/check-fleet.js       # read-only fleet health
node src/refill.js            # top up everything to TARGET_TOPUP
node src/fix-record.js        # reconcile failed/unverified rows
```

### Run everything inside the container

```powershell
railway.cmd ssh                     # ← correct
railway.cmd run node src/…          # ← WRONG: runs locally against a local DB_PATH
```

### `/status` fields

`paused` · `deadline` · `msRemaining` · `feesSpentBot` · `budgetCapBot` ·
`walletsDueNow` *(actually in-flight count, not due count — see §8)* ·
`weeklyVotes` · `weeklyRank` · `top20VotesNeeded` · `votes[]` · `wallets[]`

The board fields are cached 5 minutes and seeded from the boot fetch, so `/status`
costs at most one API call per 5 min.

**`/status` is unauthenticated.** If you generate a public Railway domain, anyone with
the URL can read counts and balances. No keys are exposed.

---

## 8. Known defects and loose ends

Honest list, roughly by severity.

1. **`top20VotesNeeded` is nonsense** (`scheduler.js`): `Math.max(0, 520 - weeklyVoteCount)`
   uses a hardcoded 520 placeholder. It currently reports ~515. The real gap is not known
   — the public API only returns the project you name, so there is no way to read the
   #20 threshold from it.
2. **The divergence detector can never fire** (`monitor.js`): it warns when
   `weeklyVoteCount < 4`, but the baseline is already 5. Indexing lag shows up as the
   counter *staying* at 5, never dropping below 4 — so it prints "tracking healthy" during
   exactly the failure it exists to catch.
3. **Cooldown gate is conditional on whitelist** (`voter.js:20`):
   `if (!isWhitelisted && now < nextVoteAt + buffer)`. A whitelisted wallet skips the cheap
   local check and relies on `staticCall` to revert instead — correct but wasteful.
4. **`walletsDueNow` is mislabelled**: it reports `running.size` (in flight). The real
   "due" computation exists as `totalDue()` and is **never called** — dead code.
5. **`MAX_ATTEMPTS` is unused** (`voter.js:9`). There is no retry logic beyond the tick loop.
6. **Reverted txs burn gas that the budget cap never sees** — the `rc.status !== 1` throw
   happens before fee accounting. Rare, but the cap under-counts.
7. **`funded_amount` means "target", not "total sent"** (`refill.js` writes `TARGET`).
   `SUM(funded_amount)` is not a spend figure. `funder_tx_hash` keeps the *first* funding
   tx via `COALESCE`, so the pair no longer describes one event.
8. **`DIST_RESERVE_WEI = 0.06` covers ~95 transfers at the 30 gwei cap** — thinner than a
   100-wallet run needs. Fails gracefully (partial run, re-running resumes).
9. **Sequential RPC reads** in `check-fleet.js` and `refill.js`: one round trip per wallet.
   At 100+ wallets this is 30–60s. `Promise.all` would batch, if the RPC accepts batches.
10. **No tests.** Verification so far has been manual: scratch DBs, synthetic logs, and
    live read-only API probes. No CI.
11. **No alerting.** Failures appear only in Railway's stdout logs.
12. **`monitor.js` imports `cfg` and never uses it.**
13. **`crypto.js` throws at import**, so even `npm run check` (documented as read-only
    sanity) requires a valid `VAULT_KEY`.
14. **`railway.json` cannot mount volumes** — the `/data` mount must be set in the
    dashboard. The file's `volumeMounts` key was removed for that reason.

---

## 9. Change history

| Commit | What it fixed |
|---|---|
| `fa65c28` | Initial scaffold — 15 files, malformed `snapshots` DDL repaired |
| `31e32a9` | `verifyProjectIdentity` switched to the real POST API (GET returned the wrong shape); weekly fields pinned in `monitor.js`; board cached in `/status` |
| `0f6abce` | `args.projectId` → positional (the ABI names it `projectID`) |
| `9b4a768` | **Root cause:** `Vote` event declared `address indexed blockTs`, on-chain it is `uint256` — different signature hash, so `parseLog` never matched. Verified against 1,819 real logs. Added `unverified` status, fee accounting on failure, `fix-record.js` |
| `b0d1f04` | `check-fleet.js` |
| `69815cd` | `refill.js` |

The ABI bug is worth remembering: it was invisible from the code and provable only from
the chain. Any future "vote landed but the DB says failed" symptom should send you
straight to `cast logs` / `eth_getLogs` on the proxy and compare `topic0` against
`keccak256("Vote(uint256,address,uint256)")`.

---

## 10. What this system does not do

- No sweeping of stranded balances out of one-shot or retired wallets.
- No key export tooling (deliberate).
- No nonce management beyond ethers' defaults — `fund.js` and `refill.js` send strictly
  sequentially, so the funder never races itself.
- No graceful SIGTERM handling. In-flight txs still land; the DB is WAL so it survives.
- No multi-project support: `PROJECT_ID` is global.
