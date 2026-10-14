import crypto from "crypto";

let vaultKey;
try {
  vaultKey = Buffer.from(process.env.VAULT_KEY, "base64");
} catch {
  vaultKey = Buffer.alloc(0);
}
if (vaultKey.length !== 32) {
  throw new Error("VAULT_KEY must be set (32 bytes, base64). Generate: openssl rand -base64 32");
}

export function encryptKey(privateKeyHex) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", vaultKey, iv);
  const ct = Buffer.concat([cipher.update(privateKeyHex, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ct].map((b) => b.toString("base64")).join(":");
}

export function decryptKey(payload) {
  const [iv, tag, ct] = payload.split(":").map((s) => Buffer.from(s, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", vaultKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
