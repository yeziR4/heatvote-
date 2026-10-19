// src/refill.js — top up every wallet to TARGET_TOPUP (checks real on-chain balance first)
// Partial mode: if the funder cannot cover every top-up, fund as many as fit (DB id order,
// keeping the distribution reserve) and leave the rest for the next run. Exits 1 only if
// nothing could be funded. DRY_RUN=1 prints the plan without moving anything.
import { ethers } from "ethers";
import { cfg } from "./config.js";
import { db } from "./db.js";
import { provider, funderWallet } from "./provider.js";

const TARGET = ethers.parseEther(process.env.TARGET_TOPUP || "0.0085");
const DRY_RUN = process.env.DRY_RUN === "1";
const funder = funderWallet();

const rows = db.prepare(
  "SELECT * FROM wallets WHERE status != 'retired' AND consent_withdrawn = 0"
).all();

// read every balance first, then plan the top-ups in DB id order
const plan = [];
let totalNeeded = 0n;
for (const w of rows) {
  const bal = await provider.getBalance(w.address);
  if (bal < TARGET) {
    const send = TARGET - bal;
    totalNeeded += send;
    plan.push({ row: w, bal, send });
  }
}
const funderBal = await provider.getBalance(funder.address);
const DIST_RESERVE_WEI = ethers.parseEther("0.06"); // for ~100 transfer gas costs

const feeData = await provider.getFeeData();
let gasPrice = feeData.gasPrice ?? 20n * 10n ** 9n;
if (gasPrice > cfg.maxGasPriceGwei * 10n ** 9n) gasPrice = cfg.maxGasPriceGwei * 10n ** 9n;
const transferGas = 21000n * gasPrice;

console.log(`wallets needing top-up: ${plan.length}, total needed: ${ethers.formatEther(totalNeeded)} BOT`);
console.log(`funder balance: ${ethers.formatEther(funderBal)} BOT (after full run: ${ethers.formatEther(funderBal - totalNeeded - DIST_RESERVE_WEI)})`);

if (DRY_RUN) {
  for (const { row, bal, send } of plan) {
    console.log(`DRY ${row.address} bal=${ethers.formatEther(bal)} send=${ethers.formatEther(send)} -> ${ethers.formatEther(TARGET)}BOT`);
  }
  let avail = funderBal - DIST_RESERVE_WEI;
  let afford = 0;
  for (const { send } of plan) {
    const cost = send + transferGas;
    if (avail < cost) break;
    avail -= cost;
    afford++;
  }
  console.log(`DRY RUN — no transactions sent. wallets affordable now: ${afford}/${plan.length} (transferGas=${ethers.formatEther(transferGas)}BOT)`);
  process.exit(0);
}

if (plan.length === 0) { console.log("all wallets at target"); process.exit(0); }

let spendable = funderBal - DIST_RESERVE_WEI;
let funded = 0;
for (const { row, send } of plan) {
  const cost = send + transferGas;
  if (spendable < cost) break;
  spendable -= cost;
  const tx = await funder.sendTransaction({ to: row.address, value: send, gasLimit: 21000n, gasPrice, type: 0 });
  const rc = await tx.wait();
  if (rc.status !== 1) throw new Error(`top-up reverted for ${row.address}`);
  db.prepare("UPDATE wallets SET funder_tx_hash=COALESCE(funder_tx_hash,?), funded_amount=? WHERE id=?")
    .run(tx.hash, ethers.formatEther(TARGET), row.id);
  console.log(`topped ${row.address} +${ethers.formatEther(send)}BOT`);
  funded++;
}

if (funded === 0) {
  console.error("FUNDER CANNOT COVER ANY TOP-UP — fund the funder wallet or set a lower TARGET_TOPUP (e.g. 0.004)");
  process.exit(1);
}
const remaining = plan.length - funded;
if (remaining > 0) {
  console.warn(`partial run: funded ${funded}/${plan.length}, ${remaining} wallets still below target — fund the funder wallet and re-run`);
}
console.log("REFILL COMPLETE");
