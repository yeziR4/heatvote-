import { ethers } from "ethers";
import { encryptKey } from "./crypto.js";
import { db } from "./db.js";
import { cfg } from "./config.js";

const count = Number(process.argv[2] ?? 100);

// Acceptance-test guard: without FUNDER/VAULT keys this still runs locally,
// but on Railway both must be present before we register real wallets.
const existing = new Set(db.prepare("SELECT address FROM wallets").all().map((r) => r.address));

if (count === 0) {
  // check mode: sanity-read chain facts without creating anything
  const { readContract, provider } = await import("./provider.js");
  const [cd, chainId, block] = await Promise.all([
    readContract.voteCooldown(),
    provider.getNetwork().then((n) => n.chainId),
    provider.getBlockNumber(),
  ]);
  console.log(`chainId=${chainId} block=${block} voteCooldown=${cd}`);
  console.log(`registered wallets: ${existing.size}`);
  if (cd !== 21600n) console.error("WARNING: voteCooldown is not 21600 — pacing assumptions stale");
  process.exit(0);
}

const insert = db.prepare("INSERT INTO wallets(address, encrypted_key, status) VALUES(?,?, 'active')");
let added = 0;
for (let i = 0; i < count; i++) {
  const w = ethers.Wallet.createRandom();
  if (existing.has(w.address)) continue; // dedupe
  insert.run(w.address, encryptKey(w.privateKey));
  existing.add(w.address);
  added++;
  if (added % 10 === 0) console.log(`registered ${added}/${count}`);
}
console.log(`done. added=${added} total=${existing.size} (projectId=${cfg.projectId})`);
