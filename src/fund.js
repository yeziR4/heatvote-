import { ethers } from "ethers";
import { cfg } from "./config.js";
import { db } from "./db.js";
import { provider, funderWallet } from "./provider.js";

const amount = ethers.parseEther(cfg.perWalletAllocation);
const funder = funderWallet();

const targets = db.prepare(
  "SELECT * FROM wallets WHERE funder_tx_hash IS NULL AND consent_withdrawn = 0 AND status != 'retired'"
).all();

if (targets.length === 0) { console.log("nothing to fund"); process.exit(0); }

// Funder must keep a reserve for distribution gas
const DIST_RESERVE_WEI = ethers.parseEther("0.05");
const balance = await provider.getBalance(funder.address);
const needed = amount * BigInt(targets.length) + DIST_RESERVE_WEI;
console.log(`funder ${funder.address} balance=${ethers.formatEther(balance)}BOT need=${ethers.formatEther(needed)}BOT for ${targets.length} wallets`);
if (balance < needed) {
  console.error("INSUFFICIENT FUNDER BALANCE — lower PER_WALLET_ALLOCATION or fund more BOT");
  process.exit(1);
}

for (const w of targets) {
  const gasPrice = await provider.getFeeData().then((d) => d.gasPrice);
  const capped = gasPrice > cfg.maxGasPriceGwei * 10n ** 9n ? cfg.maxGasPriceGwei * 10n ** 9n : gasPrice;
  const tx = await funder.sendTransaction({ to: w.address, value: amount, gasLimit: 21000n, gasPrice: capped, type: 0 });
  const rc = await tx.wait();
  if (rc.status !== 1) throw new Error(`funding tx reverted for ${w.address}`);
  db.prepare("UPDATE wallets SET funder_tx_hash=?, funded_amount=? WHERE id=?").run(tx.hash, cfg.perWalletAllocation, w.id);
  console.log(`funded ${w.address} ${cfg.perWalletAllocation}BOT ${tx.hash}`);
}
console.log("funding complete");
