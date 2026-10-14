import "dotenv/config";

const num = (v, d) => (v === undefined ? d : Number(v));

export const cfg = {
  rpcUrl: process.env.RPC_URL || "https://rpc.botchain.ai",
  chainId: num(process.env.CHAIN_ID, 677),
  votingProxy: process.env.VOTING_PROXY || "0xF5b22756CbD9193CE6F349bbD1835c2e5a6Cb181",
  projectId: BigInt(process.env.PROJECT_ID || 597),
  perWalletAllocation: process.env.PER_WALLET_ALLOCATION || "0.0085",
  deadline: new Date(process.env.CAMPAIGN_DEADLINE || "2026-10-18T16:00:00Z"),
  maxGasPriceGwei: BigInt(num(process.env.MAX_GAS_PRICE_GWEI, 30)),
  budgetCapWei: BigInt(Math.round(parseFloat(process.env.BUDGET_CAP_BOT || "1.04") * 1e18)),
  tickSeconds: num(process.env.TICK_SECONDS, 20),
  maxConcurrent: num(process.env.MAX_CONCURRENT_VOTES, 3),
  cooldownBuffer: num(process.env.COOLDOWN_BUFFER_SECONDS, 180),
  dbPath: process.env.DB_PATH || "./data/campaign.db",
  port: num(process.env.PORT, 8080),
};

// Minimum balance a wallet must retain to attempt a vote (worst-case fee + margin)
export const MIN_VOTE_FUNDING_WEI = 2_000_000_000_000_000n; // 0.002 BOT
