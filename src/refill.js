// src/refill.js — top up every wallet to TARGET_TOPUP (checks real on-chain balance first)
import { ethers } from "ethers";
import { cfg } from "./config.js";
import { db } from "./db.js";
import { provider, funderWallet } from "./provider.js";

const TARGET = ethers.parseEther(process.env.TARGET_TOPUP || "0.0085");
const funder = funderWallet();

const rows = db.prepare(
  "SELECT * FROM wallets WHERE status != 'retired' AND consent_withdrawn = 0"
).all();

// read every balance first, plan the total, verify the funder can cover it
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
const funderBal = await provider.getBalance(funder.address);
const DIST_RESERVE_WEI = ethers.parseEther("0.06"); // for ~100 transfer gas costs

console.log(`wallets needing top-up: ${plan.length}, total needed: ${ethers.formatEther(totalNeeded)} BOT`);
console.log(`funder balance: ${ethers.formatEther(funderBal)} BOT (after: ${ethers.formatEther(funderBal - totalNeeded - DIST_RESERVE_WEI)})`);
if (funderBal < totalNeeded + DIST_RESERVE_WEI) {
  console.error("FUNDER CANNOT COVER THIS TOP-UP — set a lower TARGET_TOPUP (e.g. 0.008 or 0.007)");
  process.exit(1);
}

for (const { row, send } of plan) {
  const gasPrice = (await provider.getFeeData()).gasPrice;
  const capped = gasPrice > cfg.maxGasPriceGwei * 10n ** 9n ? cfg.maxGasPriceGwei * 10n ** 9n : gasPrice;
  const tx = await funder.sendTransaction({ to: row.address, value: send, gasLimit: 21000n, gasPrice: capped, type: 0 });
  const rc = await tx.wait();
  if (rc.status !== 1) throw new Error(`top-up reverted for ${row.address}`);
  db.prepare("UPDATE wallets SET funder_tx_hash=COALESCE(funder_tx_hash,?), funded_amount=? WHERE id=?")
    .run(tx.hash, ethers.formatEther(TARGET), row.id);
  console.log(`topped ${row.address} +${ethers.formatEther(send)}BOT`);
}
console.log("REFILL COMPLETE");
