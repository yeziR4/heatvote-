import { cfg } from "./config.js";
import { db } from "./db.js";
import { verifyProjectIdentity } from "./provider.js";

console.table(db.prepare(
  "SELECT status, COUNT(*) n, ROUND(SUM(CAST(fee_bot AS REAL))/1e18, 6) fees FROM votes GROUP BY status"
).all());

const info = await verifyProjectIdentity();
db.prepare("INSERT INTO snapshots(source, matchday_votes, rank, raw) VALUES('leaderboard-api',?,?,?)")
  .run(info.voteCount ?? info.weeklyVoteCount ?? info.monthlyVoteCount ?? null,
       info.weeklyRankNo ?? info.monthlyRankNo ?? null,
       JSON.stringify(info).slice(0, 2000));

const confirmed = db.prepare("SELECT COUNT(*) n FROM votes WHERE status='confirmed'").get().n;
console.log("--- official API says ---");
console.log(JSON.stringify(info, null, 2));
console.log(`on-chain confirmed by us: ${confirmed}`);
console.log(`NOTE: compare which API field tracks WEEKLY vs MONTHLY, then adjust monitor accordingly.`);
