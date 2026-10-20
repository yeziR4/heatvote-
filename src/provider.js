import { ethers } from "ethers";
import { cfg } from "./config.js";

export const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, {
  chainId: cfg.chainId,
  name: "botchain",
  staticNetwork: true,
});

export const VOTE_ABI = [
  "function vote(uint256 projectID)",
  "function nextVoteAt(address voter) view returns (uint256)",
  "function whitelist(address account) view returns (bool)",
  "function voteCooldown() view returns (uint256)",
  "event Vote(uint256 indexed projectID, address indexed voter, uint256 indexed blockTs)",
];

export const readContract = new ethers.Contract(cfg.votingProxy, VOTE_ABI, provider);

export function makeSigner(address, decryptedPrivateKey) {
  const wallet = new ethers.Wallet(decryptedPrivateKey, provider);
  if (wallet.address.toLowerCase() !== address.toLowerCase()) {
    throw new Error(`key/address mismatch for ${address}`);
  }
  return { wallet, contract: new ethers.Contract(cfg.votingProxy, VOTE_ABI, wallet) };
}

export function funderWallets() {
  const primary = process.env.FUNDER_PRIVATE_KEY?.trim();
  const keys = [...(primary ? [primary] : []),
                ...(process.env.FUNDER_PRIVATE_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean)];
  if (keys.length === 0) throw new Error("no funder keys set (FUNDER_PRIVATE_KEY / FUNDER_PRIVATE_KEYS)");
  return keys.map((k) => new ethers.Wallet(k, provider));
}

export function funderWallet() {
  return funderWallets()[0];
}

export async function chainTime() {
  const b = await provider.getBlock("latest");
  return b.timestamp;
}

// Verify project identity from BOT Chain's public API before anything signs.
// Endpoint confirmed live 2026-10-14: POST /botadmin/ecosystem/votes/search
export async function verifyProjectIdentity() {
  const res = await fetch(
    "https://botadmin-public-api.botchain.ai/botadmin/ecosystem/votes/search",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyword: "Matchday", name: "Matchday", page: 1, pageSize: 20 }),
    }
  );
  if (!res.ok) throw new Error(`project API HTTP ${res.status}`);

  const json = await res.json();
  if (json.code !== 0 || !Array.isArray(json.data)) {
    throw new Error(`project API error: code=${json.code} msg=${json.msg}`);
  }

  const p = json.data.find(
    (x) => String(x.projectId) === String(cfg.projectId) && x.projectName === "Matchday"
  );
  if (!p) throw new Error(`project ${cfg.projectId}/Matchday not found in official API (got ${json.data.length} entries)`);
  if (p.status !== "live") throw new Error(`project status is "${p.status}", expected "live"`);
  return p;
}
