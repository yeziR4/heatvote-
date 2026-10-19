// src/boot.js — optional one-shot top-up pass before the scheduler starts.
// REFILL_ON_BOOT=1 → run refill.js against whatever the funder can afford;
// any failure is logged but never fatal, then the scheduler always starts.
import "dotenv/config";

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
