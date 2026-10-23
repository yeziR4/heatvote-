// src/refill.js — top up every wallet to TARGET_TOPUP (checks real on-chain balance first).
// Funder set = FUNDER_PRIVATE_KEY + any extra keys in FUNDER_PRIVATE_KEYS (comma-separated).
// Work is distributed greedily across all funders; each keeps a share of the distribution
// reserve. Partial mode: fund as many wallets as fit (DB id order, retrying for leftovers)
// and leave the rest for the next run. Throws (never process.exit) so boot.js can continue
// to the scheduler when nothing is affordable. DRY_RUN=1 prints the plan without moving
// anything. Runs as a CLI or as an imported function from boot.js.
import { ethers } from "ethers";
import { cfg } from "./config.js";
import { db } from "./db.js";
import { provider, funderWallets } from "./provider.js";
import { pathToFileURL } from "url";

export async function refill() {
  const TARGET = ethers.parseEther(process.env.TARGET_TOPUP || "0.0085");
  const DRY_RUN = process.env.DRY_RUN === "1";
  const funders = funderWallets();

  const rows = db.prepare(
    "SELECT * FROM wallets WHERE status != 'retired' AND consent_withdrawn = 0"
  ).all();

  // read every wallet balance first, then plan the top-ups in DB id order
  const plan = [];
  let totalNeeded = 0n;
  for (const w of rows) {
    const bal = await provider.getBalance(w.address);
    if (bal < TARGET) {
      const send = TARGET - bal;
      totalNeeded += send;
      plan.push({ row: w, send });
    }
  }

  const feeData = await provider.getFeeData();
  let gasPrice = feeData.gasPrice ?? 20n * 10n ** 9n;
  if (gasPrice > cfg.maxGasPriceGwei * 10n ** 9n) gasPrice = cfg.maxGasPriceGwei * 10n ** 9n;
  const transferGas = 21000n * gasPrice;

  // each funder keeps a proportional share of the distribution reserve for its own gas
  const DIST_RESERVE_WEI = ethers.parseEther("0.06") / BigInt(funders.length);
  const balances = [];
  for (const f of funders) balances.push(await provider.getBalance(f.address));
  const spendable = balances.map((b) => b - DIST_RESERVE_WEI);

  console.log(`wallets needing top-up: ${plan.length}, total needed: ${ethers.formatEther(totalNeeded)} BOT`);
  funders.forEach((f, i) =>
    console.log(`funder ${f.address} balance=${ethers.formatEther(balances[i])} spendable=${ethers.formatEther(spendable[i])} reserve=${ethers.formatEther(DIST_RESERVE_WEI)}BOT`));

  if (DRY_RUN) {
    for (const { row, send } of plan) console.log(`DRY ${row.address} send=${ethers.formatEther(send)} -> ${ethers.formatEther(TARGET)}BOT`);
    let affordable = 0;
    const avail = [...spendable];
    for (const { send } of plan) {
      const fi = avail.findIndex((s) => s >= send + transferGas);
      if (fi === -1) continue;
      avail[fi] -= send + transferGas;
      affordable++;
    }
    console.log(`DRY RUN — no transactions sent. wallets affordable now: ${affordable}/${plan.length} (transferGas=${ethers.formatEther(transferGas)}BOT)`);
    return;
  }

  if (plan.length === 0) { console.log("all wallets at target"); return; }

  let pending = plan;
  let funded = 0;
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = 0; i < pending.length; i++) {
      const { row, send } = pending[i];
      const fi = spendable.findIndex((s) => s >= send + transferGas);
      if (fi === -1) continue;
      spendable[fi] -= send + transferGas;
      const f = funders[fi];
      const tx = await f.sendTransaction({ to: row.address, value: send, gasLimit: 21000n, gasPrice, type: 0 });
      const rc = await tx.wait();
      if (rc.status !== 1) throw new Error(`top-up reverted for ${row.address}`);
      db.prepare("UPDATE wallets SET funder_tx_hash=COALESCE(funder_tx_hash,?), funded_amount=? WHERE id=?")
        .run(tx.hash, ethers.formatEther(TARGET), row.id);
      console.log(`topped ${row.address} +${ethers.formatEther(send)}BOT via ${f.address.slice(0, 10)}…`);
      pending.splice(i, 1);
      i--;
      funded++;
      progress = true;
    }
  }

  if (funded === 0) {
    throw new Error(`FUNDER CANNOT COVER ANY TOP-UP (${funders.length} funder(s), all below reserve) — fund a funder wallet or set a lower TARGET_TOPUP (e.g. 0.004)`);
  }
  if (pending.length > 0) {
    console.warn(`partial run: funded ${funded}/${plan.length}, ${pending.length} wallets still below target — fund a funder wallet and re-run`);
  }
  console.log("REFILL COMPLETE");
}

// run as CLI only when executed directly (npm start / shell), not when imported by boot.js
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  refill()
    .catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); })
    .then(() => process.exit(0));
}
