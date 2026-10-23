// src/boot.js — boot sequence for `npm start`:
// 1. Self-heal the budget-cap pause: if fees are now below the configured cap
//    (i.e. BUDGET_CAP_BOT was raised), clear the pause so a deploy alone resumes.
// 2. FLEET_TARGET=N (optional): create voter wallets until the DB holds N of them.
// 3. REFILL_ON_BOOT=1 (optional): run one partial refill pass.
// 4. Start the scheduler. Optional steps are best-effort and never fatal.
import "dotenv/config";
import { cfg } from "./config.js";
import { db, kv } from "./db.js";

if (kv.get("paused") === "1") {
  const fees = BigInt(kv.get("total_fees_bot") ?? "0");
  if (fees < cfg.budgetCapWei) {
    kv.set("paused", "0");
    console.log("pause cleared: fees below current BUDGET_CAP_BOT — resuming");
  } else {
    console.error(`still over budget cap (fees=${Number(fees) / 1e18} >= cap=${Number(cfg.budgetCapWei) / 1e18}) — staying paused`);
  }
}

if (process.env.FLEET_TARGET) {
  const fleetCount = () => db.prepare("SELECT COUNT(*) n FROM wallets").get().n;
  const target = Number(process.env.FLEET_TARGET);
  try {
    if (fleetCount() < target) {
      const { growFleet } = await import("./fleet.js");
      const { created, total } = await growFleet(target);
      console.log(`fleet grown +${created} -> ${total} wallets (target ${target})`);
    } else {
      console.log(`fleet already at/above FLEET_TARGET (${fleetCount()} >= ${target}) — no new wallets`);
    }
  } catch (e) {
    console.error("fleet growth failed (continuing):", e?.message ?? e);
  }
} else {
  console.log("FLEET_TARGET not set — no new wallets");
}

if (process.env.REFILL_ON_BOOT === "1") {
  try {
    const { refill } = await import("./refill.js");
    await refill();
  } catch (e) {
    console.error("boot refill failed (continuing):", e?.message ?? e);
  }
} else {
  console.log("REFILL_ON_BOOT not set — skipping top-up pass");
}

await import("./scheduler.js");
