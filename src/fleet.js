// src/fleet.js — grow the wallet fleet to an absolute size target.
// Shared by init-wallets.js (CLI) and boot.js (FLEET_TARGET flag).
import { ethers } from "ethers";
import { encryptKey } from "./crypto.js";
import { db } from "./db.js";

export async function growFleet(target) {
  const existing = new Set(db.prepare("SELECT address FROM wallets").all().map((r) => r.address));
  const insert = db.prepare("INSERT INTO wallets(address, encrypted_key, status) VALUES(?,?, 'active')");
  let created = 0;
  while (existing.size < target) {
    const w = ethers.Wallet.createRandom();
    if (existing.has(w.address)) continue;
    insert.run(w.address, encryptKey(w.privateKey));
    existing.add(w.address);
    created++;
  }
  return { created, total: existing.size };
}
