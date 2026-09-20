// Usage report for Number Bomb.
//
//   npm run usage
//
// The game ships no analytics — nothing is tracked, no third party is told
// anything, and that is deliberate. The only record of play that exists is the
// one the game needs anyway: every synced room is a document under `rooms/`,
// and nothing ever deletes it. This reads those documents and counts them.
//
// Two things it cannot see, and no amount of work here would change either:
//
//   - Pass-the-phone and relay games never touch a backend, so they leave no
//     trace at all. Everything below is synced rooms only, and the real number
//     of games played is higher by an unknown amount.
//   - Rooms created before v3 (the lucky spin) have no `spin` field and no
//     skips in their logs. They still count as games; they just cannot
//     contribute to the spin figures.
//
// It reads with the same anonymous sign-in and the same rules as a player, so
// it can see nothing a player could not. It writes nothing.

import { readFileSync } from "node:fs";
import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getFirestore, collection, getDocs } from "firebase/firestore";

/** The web config the page itself uses. Not a secret — it ships in every browser. */
export function readConfig(path = new URL("../config.js", import.meta.url)){
  const src = readFileSync(path, "utf8");
  const scope = { window: {} };
  new Function("window", src)(scope.window);
  const cfg = scope.window.NUMBER_BOMB_FIREBASE;
  if (!cfg || !cfg.projectId) throw new Error("config.js has no NUMBER_BOMB_FIREBASE config");
  return cfg;
}

const pct = (n, of) => of ? `${((n / of) * 100).toFixed(0)}%` : "—";
const day = ms => new Date(ms).toISOString().slice(0, 10);

/**
 * Everything below is derived from the room documents alone — pure, so it can
 * be checked against known rooms without a network.
 */
export function summarise(rooms){
  const out = {
    rooms: rooms.length,
    lobbiesNeverStarted: 0,
    started: 0,
    finished: 0,
    abandonedMidGame: 0,
    turns: 0, guesses: 0, skips: 0, doubles: 0, trashTalk: 0,
    players: new Set(), names: new Set(),
    byDay: new Map(),
    biggestTable: 0, longestGame: 0,
    first: null, last: null
  };

  for (const r of rooms){
    const made = Number(r.createdAt) || null;
    if (made){
      out.first = out.first === null ? made : Math.min(out.first, made);
      out.last  = out.last  === null ? made : Math.max(out.last, made);
      out.byDay.set(day(made), (out.byDay.get(day(made)) || 0) + 1);
    }

    if (r.phase !== "playing"){ out.lobbiesNeverStarted++; continue; }
    out.started++;
    if (r.over) out.finished++; else out.abandonedMidGame++;

    for (const uid of r.seats || []) out.players.add(uid);
    for (const n of r.players || []) out.names.add(String(n).trim().toLowerCase());
    out.biggestTable = Math.max(out.biggestTable, (r.seats || []).length);

    const log = Array.isArray(r.history) ? r.history : [];
    out.longestGame = Math.max(out.longestGame, log.length);
    out.turns += log.length;
    for (const e of log){
      if (!e || typeof e !== "object") continue;
      if (e.side === "skip") out.skips++; else out.guesses++;
      if (typeof e.m === "string" && e.m) out.trashTalk++;
    }
    // Double Trouble is not stored, but it is visible: two guesses in a row by
    // the same player, with no skip between them, is a pair.
    for (let i = 1; i < log.length; i++){
      const a = log[i - 1], b = log[i];
      if (a && b && a.p === b.p && a.side !== "skip" && b.side !== "skip") out.doubles++;
    }
  }
  return out;
}

export function render(s){
  const L = [];
  const busiest = [...s.byDay.entries()].sort((a, b) => b[1] - a[1])[0];
  L.push("NUMBER BOMB — usage to date (synced rooms only)");
  L.push("");
  L.push(`  Rooms opened          ${s.rooms}`);
  L.push(`  Games actually played ${s.started}  (${pct(s.started, s.rooms)} of rooms opened)`);
  L.push(`  Played to detonation  ${s.finished}  (${pct(s.finished, s.started)} of games)`);
  L.push(`  Abandoned mid-game    ${s.abandonedMidGame}`);
  L.push(`  Opened, never started ${s.lobbiesNeverStarted}`);
  L.push("");
  L.push(`  Distinct devices      ${s.players.size}`);
  L.push(`  Distinct player names ${s.names.size}`);
  L.push(`  Biggest table         ${s.biggestTable || "—"}`);
  L.push("");
  L.push(`  Turns taken           ${s.turns}`);
  L.push(`  ├─ guesses            ${s.guesses}`);
  L.push(`  ├─ skipped by wheel   ${s.skips}  (${pct(s.skips, s.turns)} of turns)`);
  L.push(`  └─ Double Trouble     ${s.doubles} pair${s.doubles === 1 ? "" : "s"}`);
  L.push(`  Longest game          ${s.longestGame || "—"} turns`);
  L.push(`  Lines of trash talk   ${s.trashTalk}`);
  L.push("");
  if (s.first) L.push(`  First room            ${day(s.first)}`);
  if (s.last)  L.push(`  Most recent room      ${day(s.last)}`);
  if (busiest) L.push(`  Busiest day           ${busiest[0]} (${busiest[1]} rooms)`);
  L.push("");
  L.push("  Pass-the-phone and relay games are not counted — they never reach a");
  L.push("  backend, so the true number of games played is higher than this.");
  return L.join("\n");
}

async function main(){
  const cfg = readConfig();
  const app = initializeApp(cfg);
  const db = getFirestore(app);
  // The rules allow any signed-in player to read rooms, and nothing more. This
  // signs in the same way the page does, sees exactly what a player sees, and
  // writes nothing.
  await signInAnonymously(getAuth(app));
  const snap = await getDocs(collection(db, "rooms"));
  console.log(render(summarise(snap.docs.map(d => d.data()))));
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
