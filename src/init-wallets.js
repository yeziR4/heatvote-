import { cfg } from "./config.js";
import { db } from "./db.js";

const count = Number(process.argv[2] ?? 100);
const existing = db.prepare("SELECT address FROM wallets").all().map((r) => r.address);

if (count === 0) {
  // check mode: sanity-read chain facts without creating anything
  const { readContract, provider } = await import("./provider.js");
  const [cd, chainId, block] = await Promise.all([
    readContract.voteCooldown(),
    provider.getNetwork().then((n) => n.chainId),
    provider.getBlockNumber(),
  ]);
  console.log(`chainId=${chainId} block=${block} voteCooldown=${cd}`);
  console.log(`registered wallets: ${existing.length}`);
  if (cd !== 21600n) console.error("WARNING: voteCooldown is not 21600 — pacing assumptions stale");
  process.exit(0);
}

const { growFleet } = await import("./fleet.js");
const before = existing.length;
const { created, total } = await growFleet(before + count);
console.log(`done. added=${created} total=${total} (projectId=${cfg.projectId})`);
