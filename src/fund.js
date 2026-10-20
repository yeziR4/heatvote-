import { ethers } from "ethers";
import { cfg } from "./config.js";
import { db } from "./db.js";
import { provider, funderWallets } from "./provider.js";

const amount = ethers.parseEther(cfg.perWalletAllocation);
const funders = funderWallets();

const targets = db.prepare(
  "SELECT * FROM wallets WHERE funder_tx_hash IS NULL AND consent_withdrawn = 0 AND status != 'retired'"
).all();

if (targets.length === 0) { console.log("nothing to fund"); process.exit(0); }

// each funder keeps a proportional share of the distribution reserve for its own gas
const feeData = await provider.getFeeData();
let gasPrice = feeData.gasPrice ?? 20n * 10n ** 9n;
if (gasPrice > cfg.maxGasPriceGwei * 10n ** 9n) gasPrice = cfg.maxGasPriceGwei * 10n ** 9n;
const transferGas = 21000n * gasPrice;

const DIST_RESERVE_WEI = ethers.parseEther("0.06") / BigInt(funders.length);
const balances = [];
for (const f of funders) balances.push(await provider.getBalance(f.address));
const spendable = balances.map((b) => b - DIST_RESERVE_WEI);

console.log(`need=${ethers.formatEther(amount * BigInt(targets.length))}BOT for ${targets.length} wallets`);
funders.forEach((f, i) =>
  console.log(`funder ${f.address} balance=${ethers.formatEther(balances[i])} spendable=${ethers.formatEther(spendable[i])} reserve=${ethers.formatEther(DIST_RESERVE_WEI)}BOT`));

let pending = targets;
let funded = 0;
let progress = true;
while (progress) {
  progress = false;
  for (let i = 0; i < pending.length; i++) {
    const w = pending[i];
    const fi = spendable.findIndex((s) => s >= amount + transferGas);
    if (fi === -1) continue;
    spendable[fi] -= amount + transferGas;
    const f = funders[fi];
    const tx = await f.sendTransaction({ to: w.address, value: amount, gasLimit: 21000n, gasPrice, type: 0 });
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error(`funding tx reverted for ${w.address}`);
    db.prepare("UPDATE wallets SET funder_tx_hash=?, funded_amount=? WHERE id=?").run(tx.hash, cfg.perWalletAllocation, w.id);
    console.log(`funded ${w.address} ${cfg.perWalletAllocation}BOT via ${f.address.slice(0, 10)}… ${tx.hash}`);
    pending.splice(i, 1);
    i--;
    funded++;
    progress = true;
  }
}

if (funded === 0) {
  console.error(`INSUFFICIENT FUNDER BALANCE (${funders.length} funder(s)) — lower PER_WALLET_ALLOCATION or fund more BOT`);
  process.exit(1);
}
if (pending.length > 0) {
  console.warn(`partial run: funded ${funded}/${targets.length}, ${pending.length} wallets still un-funded — run again after funding the funder wallets`);
}
console.log("funding complete");
