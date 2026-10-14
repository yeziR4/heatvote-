import http from "http";
import { cfg } from "./config.js";
import { db, kv } from "./db.js";
import { readContract, verifyProjectIdentity } from "./provider.js";
import { voteOnce } from "./voter.js";

// ---- Boot gates: abort loudly if assumptions are broken ----
const cooldown = await readContract.voteCooldown();
if (cooldown !== 21600n) {
  console.error(`voteCooldown is ${cooldown}, expected 21600 — review pacing before running`);
  process.exit(1);
}
const projectInfo = await verifyProjectIdentity();
if (String(projectInfo.projectId) !== String(cfg.projectId)) {
  console.error(`API projectId mismatch: got ${projectInfo.projectId}`);
  process.exit(1);
}
console.log(`boot OK — project: ${projectInfo.projectName} (id ${projectInfo.projectId})`);

// ---- Leaderboard cache: at most one API refresh per 5 min (their limit is 100 req/min) ----
// Seeded from the boot-time fetch so we don't spend a second call on startup.
let cachedBoard = projectInfo, boardAt = Date.now();
async function refreshBoard() {
  if (Date.now() - boardAt < 5 * 60 * 1000 && cachedBoard) return cachedBoard;
  try {
    cachedBoard = await verifyProjectIdentity();
    boardAt = Date.now();
  } catch { /* keep old cache; board is non-critical */ }
  return cachedBoard;
}

const running = new Set();

function totalDue() {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = db.prepare(
    "SELECT * FROM wallets WHERE status='active' AND consent_withdrawn=0"
  ).all();
  let due = 0;
  for (const row of rows) {
    if (running.has(row.address)) continue;
    const last = db.prepare(
      "SELECT next_eligible_at FROM votes WHERE wallet_address=? AND status IN ('confirmed','timeout','unverified') ORDER BY id DESC LIMIT 1"
    ).get(row.address);
    const nextAt = last?.next_eligible_at ?? 0;
    if (nextAt + cfg.cooldownBuffer <= nowSec) due++;
  }
  return due;
}

async function tick() {
  if (kv.get("paused") === "1") return;
  if (new Date() >= cfg.deadline) return; // deadline reached; idles quietly
  const feesSoFar = BigInt(kv.get("total_fees_bot") ?? "0");
  if (feesSoFar >= cfg.budgetCapWei) {
    if (kv.get("paused") !== "1") { kv.set("paused", "1"); console.log("BUDGET CAP — paused"); }
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const rows = db.prepare("SELECT * FROM wallets WHERE status='active' AND consent_withdrawn=0").all();

  let launched = 0;
  for (const row of rows) {
    if (launched >= cfg.maxConcurrent - running.size) break;
    if (running.has(row.address)) continue;
    const last = db.prepare(
      "SELECT next_eligible_at, status FROM votes WHERE wallet_address=? AND status IN ('confirmed','timeout','unverified') ORDER BY id DESC LIMIT 1"
    ).get(row.address);
    // 'timeout' votes: unknown state — voter.js re-reads chain, which is authoritative
    const nextAt = last?.next_eligible_at ?? 0;
    if (nextAt + cfg.cooldownBuffer > nowSec) continue;

    running.add(row.address);
    launched++;
    voteOnce(row)
      .then((r) => {
        if (r.voted) console.log(`VOTE  ${row.address} ${r.txHash} fee=${r.fee}BOT`);
        else if (r.skipped) console.log(`SKIP  ${row.address} ${r.skipped}`);
        else console.warn(`FAIL  ${row.address} ${r.txHash ?? ""} ${r.error}`);
      })
      .catch((e) => console.error(`CRASH ${row.address} ${String(e.message).slice(0, 150)}`))
      .finally(() => running.delete(row.address));
  }
}

setInterval(tick, cfg.tickSeconds * 1000);
tick();
console.log(`scheduler up: projectId=${cfg.projectId} deadline=${cfg.deadline.toISOString()} tick=${cfg.tickSeconds}s`);

// ---- /status endpoint for checking from your phone ----
http.createServer(async (req, res) => {
  if (req.url !== "/status" && req.url !== "/") { res.writeHead(404); return res.end(); }
  const votes = db.prepare("SELECT status, COUNT(*) n FROM votes GROUP BY status").all();
  const fees = Number(kv.get("total_fees_bot") ?? "0") / 1e18;
  const wallets = db.prepare("SELECT status, COUNT(*) n FROM wallets GROUP BY status").all();
  const board = await refreshBoard(); // cached; hits the API at most every 5 min
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    paused: kv.get("paused") === "1",
    deadline: cfg.deadline.toISOString(),
    msRemaining: Math.max(0, cfg.deadline - Date.now()),
    feesSpentBot: fees.toFixed(6),
    budgetCapBot: Number(cfg.budgetCapWei) / 1e18,
    walletsDueNow: running.size,
    weeklyVotes: board?.weeklyVoteCount ?? null,
    weeklyRank: board?.weeklyRankNo ?? null,
    top20VotesNeeded: board ? Math.max(0, 520 - board.weeklyVoteCount) : null, // rough #20 target
    votes, wallets,
  }, null, 2));
}).listen(cfg.port, () => console.log(`status endpoint on :${cfg.port}/status`));
