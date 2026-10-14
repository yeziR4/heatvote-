import { db, kv } from "./db.js";
const [,, cmd, arg] = process.argv;

const cmds = {
  pause: () => { kv.set("paused", "1"); console.log("campaign PAUSED"); },
  resume: () => { kv.set("paused", "0"); console.log("campaign RESUMED"); },
  "pause-wallet": () => { db.prepare("UPDATE wallets SET status='paused' WHERE address=?").run(arg); console.log("paused:", arg); },
  "resume-wallet": () => { db.prepare("UPDATE wallets SET status='active' WHERE address=? AND consent_withdrawn=0").run(arg); console.log("resumed:", arg); },
  "retire-wallet": () => { db.prepare("UPDATE wallets SET status='retired', consent_withdrawn=1 WHERE address=?").run(arg); console.log("retired (consent withdrawn):", arg); },
};
cmds.status = () => {
  console.log(`paused=${kv.get("paused")} fees=${Number(kv.get("total_fees_bot")) / 1e18} BOT`);
  console.table(db.prepare("SELECT status, COUNT(*) n FROM wallets GROUP BY status").all());
  console.table(db.prepare("SELECT status, COUNT(*) n FROM votes GROUP BY status").all());
  console.table(db.prepare("SELECT source, matchday_votes, rank, taken_at FROM snapshots ORDER BY id DESC LIMIT 5").all());
};

(cmds[cmd] ?? (() => { console.log("usage: pause|resume|status|pause-wallet <addr>|resume-wallet <addr>|retire-wallet <addr>"); }))();
