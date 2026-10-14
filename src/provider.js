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
  "event Vote(uint256 indexed projectID, address indexed voter, address indexed blockTs)",
];

export const readContract = new ethers.Contract(cfg.votingProxy, VOTE_ABI, provider);

export function makeSigner(address, decryptedPrivateKey) {
  const wallet = new ethers.Wallet(decryptedPrivateKey, provider);
  if (wallet.address.toLowerCase() !== address.toLowerCase()) {
    throw new Error(`key/address mismatch for ${address}`);
  }
  return { wallet, contract: new ethers.Contract(cfg.votingProxy, VOTE_ABI, wallet) };
}

export function funderWallet() {
  if (!process.env.FUNDER_PRIVATE_KEY) throw new Error("FUNDER_PRIVATE_KEY not set");
  return new ethers.Wallet(process.env.FUNDER_PRIVATE_KEY, provider);
}

export async function chainTime() {
  const b = await provider.getBlock("latest");
  return b.timestamp;
}

// Verify project identity from BOT Chain's public API before anything signs
export async function verifyProjectIdentity() {
  const res = await fetch("https://botadmin-public-api.botchain.ai/botadmin/ecosystem/votes/search");
  if (!res.ok) throw new Error(`project API HTTP ${res.status}`);
  const projects = await res.json();
  const p = Array.isArray(projects) ? projects.find((x) => x.projectId === Number(cfg.projectId)) : null;
  if (!p) throw new Error(`project ${cfg.projectId} not found in official API`);
  return p;
}
