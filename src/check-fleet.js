// Fleet balance check: how many voter wallets can actually pay for a vote right now.
//
// Run INSIDE the container (`railway ssh` then `node src/check-fleet.js`) so it reads
// the real /data/campaign.db. `railway run` from your PC injects the env vars into a
// LOCAL process and would inspect your local DB_PATH instead — a different database.
//
// Needs DB + RPC only: no VAULT_KEY, no keys decrypted, no transactions signed.
import { db } from "./db.js";
import { provider } from "./provider.js";
import { MIN_VOTE_FUNDING_WEI } from "./config.js";

const all = db.prepare("SELECT address, status, consent_withdrawn, funder_tx_hash FROM wallets").all();
// Only wallets the scheduler will actually use — a paused or retired wallet being
// empty is not fleet sickness.
const rows = all.filter((w) => w.status === "active" && w.consent_withdrawn === 0);

let healthy = 0, totalBal = 0n;
const neverFunded = [], drained = [];

for (const r of rows) {
  const bal = await provider.getBalance(r.address);
  totalBal += bal;
  if (bal < MIN_VOTE_FUNDING_WEI) {          // below vote minimum
    (r.funder_tx_hash ? drained : neverFunded).push(r.address);
  } else healthy++;
}

const ignored = all.length - rows.length;
console.log(`wallets in DB:  ${all.length}${ignored ? `  (${ignored} paused/retired, excluded below)` : ""}`);
console.log(`active fleet:   ${rows.length}`);
console.log(`healthy:        ${healthy}`);
console.log(`never funded:   ${neverFunded.length} ${neverFunded.slice(0, 5).join(", ")}`);
console.log(`funded but low: ${drained.length} ${drained.slice(0, 5).join(", ")}`);
console.log(`total across active voter wallets: ${Number(totalBal) / 1e18} BOT`);
