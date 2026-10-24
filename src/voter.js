import { ethers } from "ethers";
import { cfg, MIN_VOTE_FUNDING_WEI } from "./config.js";
import { db, kv } from "./db.js";
import { provider, readContract, makeSigner, chainTime } from "./provider.js";
import { decryptKey } from "./crypto.js";

const GAS_LIMIT_CAP = 80_000n;   // observed 38k-56k on real votes
const WAIT_TIMEOUT_MS = 180_000; // 3 min to mine
const MAX_ATTEMPTS = 2;
const RPC_TIMEOUT_MS = 25_000;   // free calls must not wedge the tick loop (observed black-holed sockets)

function withTimeout(p, what) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`rpc-timeout: ${what}`)), RPC_TIMEOUT_MS)),
  ]);
}

export async function voteOnce(row, attempt = 1) {
  const { wallet, contract } = makeSigner(row.address, decryptKey(row.encrypted_key));

  // 1) Re-read on-chain eligibility — the chain is the only source of truth
  const [nextVoteAt, isWhitelisted, now] = await Promise.all([
    withTimeout(readContract.nextVoteAt(wallet.address), "nextVoteAt"),
    withTimeout(readContract.whitelist(wallet.address), "whitelist"),
    withTimeout(chainTime(), "chainTime"),
  ]);
  if (!isWhitelisted && now < Number(nextVoteAt) + cfg.cooldownBuffer) {
    return { skipped: "cooldown" };
  }

  // 2) Simulate — catches VoteCooldownActive / InvalidProject / any revert, free
  try {
    await withTimeout(readContract.vote.staticCall(cfg.projectId, { from: wallet.address }), "staticCall");
  } catch (e) {
    return { skipped: `sim-revert: ${e.shortMessage ?? String(e.message).slice(0, 120)}` };
  }

  // 3) Gas estimate + fee caps
  let gasLimit;
  try {
    const est = await withTimeout(readContract.vote.estimateGas(cfg.projectId, { from: wallet.address }), "estimateGas");
    gasLimit = (est * 12n) / 10n; // 1.2 buffer; unused gas refunded
  } catch (e) {
    return { skipped: `estimate-fail: ${e.shortMessage ?? String(e.message).slice(0, 120)}` };
  }
  if (gasLimit > GAS_LIMIT_CAP) return { skipped: `gas-above-cap(${gasLimit})` };

  let gasPrice = (await withTimeout(provider.getFeeData(), "getFeeData")).gasPrice ?? 20n * 10n ** 9n;
  const priceCap = cfg.maxGasPriceGwei * 10n ** 9n;
  if (gasPrice > priceCap) gasPrice = priceCap;

  // 4) Funding check before signing
  const balance = await withTimeout(provider.getBalance(wallet.address), "getBalance");
  if (balance < MIN_VOTE_FUNDING_WEI || balance < gasLimit * gasPrice) {
    return { skipped: "insufficient-balance" };
  }

  // 5) Sign (EIP-155) and broadcast
  const tx = await contract.vote(cfg.projectId, { gasLimit, gasPrice, type: 0, value: 0n });
  const ins = db
    .prepare("INSERT INTO votes(wallet_address, tx_hash, status) VALUES(?,?, 'pending')")
    .run(row.address, tx.hash);

  try {
    const rc = await tx.wait(1, WAIT_TIMEOUT_MS);
    if (rc.status !== 1) throw new Error(`reverted in block ${rc.blockNumber}`);

    // Gas is spent the moment the tx is mined, so compute the fee before any
    // verification step can throw — a decode hiccup must not hide a real cost.
    const feeWei = rc.gasUsed * (rc.gasPrice ?? gasPrice);

    // 6) Decode the Vote event — project AND voter must match, every time
    let event = null;
    for (const log of rc.logs) {
      try {
        const parsed = readContract.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === "Vote") { event = parsed; break; }
      } catch { /* not a Vote event */ }
    }
    // Positional access: the ABI names these `projectID`/`voter`, but index access
    // survives any ABI rename and can't silently resolve to undefined.
    const [eventProjectId, eventVoter] = event?.args ?? [];
    const verified = event &&
      BigInt(eventProjectId) === cfg.projectId &&
      String(eventVoter).toLowerCase() === wallet.address.toLowerCase();

    if (!verified) {
      // The tx landed but we cannot prove it was our vote. Record what it cost,
      // preserve the hash for the explorer, and flag it — never silently count it.
      const fallbackNext = await readContract.nextVoteAt(wallet.address).catch(() => null);
      db.prepare(
        `UPDATE votes SET status='unverified', block_number=?, fee_bot=?, error=?,
         next_eligible_at=? WHERE id=?`
      ).run(rc.blockNumber, feeWei.toString(),
           `VOTE EVENT MISMATCH — decoded project=${eventProjectId} voter=${eventVoter}`,
           fallbackNext === null ? null : Number(fallbackNext), ins.lastInsertRowid);
      kv.set("total_fees_bot", (BigInt(kv.get("total_fees_bot") ?? "0") + feeWei).toString());
      console.error(`UNVERIFIED ${row.address} ${tx.hash} block=${rc.blockNumber} fee=${ethers.formatEther(feeWei)}BOT — fee recorded, check explorer`);
      return { unverified: true, txHash: tx.hash, fee: ethers.formatEther(feeWei) };
    }

    // 7) Persist confirmation + new on-chain eligibility
    const newNext = await readContract.nextVoteAt(wallet.address);
    db.prepare(
      `UPDATE votes SET status='confirmed', block_number=?, fee_bot=?, event_project_id=?,
       event_voter=?, next_eligible_at=?, confirmed_at=datetime('now') WHERE id=?`
    ).run(rc.blockNumber, feeWei.toString(), eventProjectId.toString(),
         eventVoter, Number(newNext), ins.lastInsertRowid);

    const total = (BigInt(kv.get("total_fees_bot") ?? "0") + feeWei).toString();
    kv.set("total_fees_bot", total);
    return { voted: true, txHash: tx.hash, fee: ethers.formatEther(feeWei) };

  } catch (e) {
    const isTimeout = e.code === "TIMEOUT" || /timeout/i.test(String(e.message));
    db.prepare("UPDATE votes SET status=?, error=? WHERE id=?")
      .run(isTimeout ? "timeout" : "failed", String(e.message).slice(0, 500), ins.lastInsertRowid);
    // NEVER blind-resend: if the tx landed, nextVoteAt protects us; if not, wallet stays due.
    if (isTimeout) console.warn(`TIMEOUT ${row.address} ${tx.hash} — chain state will reconcile next tick`);
    return { error: String(e.message).slice(0, 200), isTimeout, attempt };
  }
}
