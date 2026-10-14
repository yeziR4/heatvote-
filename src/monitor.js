import { cfg } from "./config.js";
import { db } from "./db.js";
import { verifyProjectIdentity } from "./provider.js";

console.table(db.prepare(
  "SELECT status, COUNT(*) n, ROUND(SUM(CAST(fee_bot AS REAL))/1e18, 6) fees FROM votes GROUP BY status"
).all());

const info = await verifyProjectIdentity();
db.prepare("INSERT INTO snapshots(source, matchday_votes, rank, raw) VALUES('leaderboard-api',?,?,?)")
  .run(info.weeklyVoteCount, info.weeklyRankNo, JSON.stringify(info).slice(0, 2000));

const confirmed = db.prepare("SELECT COUNT(*) n FROM votes WHERE status='confirmed'").get().n;
console.log(`WEEKLY board:  votes=${info.weeklyVoteCount}  rank=#${info.weeklyRankNo}`);
console.log(`MONTHLY board: votes=${info.monthlyVoteCount} rank=#${info.monthlyRankNo}`);
console.log(`our confirmed votes this session: ${confirmed}`);
console.log(`rule check: weekly eligibility needs top 20 AND ≥20 valid votes → currently ${info.weeklyVoteCount >= 20 ? "✅" : "❌"} on the 20-vote minimum`);

// Divergence detector: every vote we confirm must move the weekly counter
// (allowing for the 3-4 already there from the earlier manual votes)
console.log(
  confirmed > 0 && info.weeklyVoteCount < 4
    ? "⚠ on-chain votes confirmed but weekly counter didn't move yet — may be indexing lag"
    : "tracking looks healthy"
);

// full raw payload last, for field-shape inspection
console.log("--- raw API entry ---");
console.log(JSON.stringify(info, null, 2));
