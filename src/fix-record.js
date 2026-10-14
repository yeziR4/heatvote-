// One-off bookkeeping: re-verify votes that were MINED but recorded as failed
// because the Vote event ABI signature was wrong (address vs uint256 blockTs).
//
// Run INSIDE the container (`railway ssh` then `node src/fix-record.js`).
// Do NOT use `railway run` from your PC — that executes locally against a local
// DB_PATH and would reconcile the wrong database.
//
// Nothing is trusted blindly: each row is re-fetched from chain, decoded with the
// corrected ABI, and only flipped to 'confirmed' if project AND voter both match.
// The fee comes from the real receipt, not a hardcoded constant.
import { cfg } from "./config.js";
import { db, kv } from "./db.js";
import { provider, readContract } from "./provider.js";

const rows = db.prepare(
  `SELECT * FROM votes
   WHERE (status='failed' AND error LIKE '%MISMATCH%') OR status='unverified'
   ORDER BY id`
).all();

if (rows.length === 0) {
  console.log("nothing to fix");
  process.exit(0);
}
console.log(`candidates: ${rows.length}`);

let fixed = 0, skipped = 0;
for (const row of rows) {
  const rc = await provider.getTransactionReceipt(row.tx_hash).catch(() => null);
  if (!rc) { console.log(`SKIP ${row.tx_hash} — receipt unavailable`); skipped++; continue; }
  if (rc.status !== 1) { console.log(`SKIP ${row.tx_hash} — tx reverted on-chain, nothing was voted`); skipped++; continue; }

  let event = null;
  for (const log of rc.logs) {
    try {
      const parsed = readContract.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "Vote") { event = parsed; break; }
    } catch { /* not a Vote event */ }
  }
  const [eventProjectId, eventVoter] = event?.args ?? [];
  const verified = event &&
    BigInt(eventProjectId) === cfg.projectId &&
    String(eventVoter).toLowerCase() === String(row.wallet_address).toLowerCase();
  if (!verified) {
    console.log(`SKIP ${row.tx_hash} — does not verify as ours (project=${eventProjectId} voter=${eventVoter})`);
    skipped++;
    continue;
  }

  const feeWei = rc.gasUsed * (rc.gasPrice ?? 0n);
  const nextAt = await readContract.nextVoteAt(row.wallet_address).catch(() => null);

  db.prepare(
    `UPDATE votes SET status='confirmed', block_number=?, fee_bot=?, event_project_id=?,
     event_voter=?, next_eligible_at=?, error=NULL, confirmed_at=datetime('now') WHERE id=?`
  ).run(rc.blockNumber, feeWei.toString(), String(eventProjectId), eventVoter,
       nextAt === null ? null : Number(nextAt), row.id);

  // Only add what wasn't already counted: failed rows had no fee recorded, while
  // 'unverified' rows already incremented the running total in voter.js.
  const delta = feeWei - BigInt(row.fee_bot ?? "0");
  if (delta !== 0n) kv.set("total_fees_bot", (BigInt(kv.get("total_fees_bot") ?? "0") + delta).toString());

  fixed++;
  console.log(`reconciled ${row.tx_hash} block=${rc.blockNumber} fee=${feeWei} wei nextEligible=${nextAt}`);
}

console.log(`done. fixed=${fixed} skipped=${skipped} total_fees=${Number(kv.get("total_fees_bot") ?? "0") / 1e18} BOT`);
