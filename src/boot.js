// src/boot.js — boot sequence for `npm start`:
// 1. FLEET_TARGET=N (optional): create voter wallets until the DB holds N of them.
// 2. REFILL_ON_BOOT=1 (optional): run one partial refill pass.
// 3. Start the scheduler. Each optional step is best-effort and never fatal.
import "dotenv/config";
import { db } from "./db.js";

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
    await import("./refill.js");
  } catch (e) {
    console.error("boot refill failed (continuing):", e?.message ?? e);
  }
} else {
  console.log("REFILL_ON_BOOT not set — skipping top-up pass");
}

await import("./scheduler.js");
