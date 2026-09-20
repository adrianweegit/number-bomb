// Tests for the usage report's counting. The network half cannot be tested
// here, but the arithmetic is where a usage report goes quietly wrong, so that
// is what these pin — against rooms whose contents are known by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarise, render } from "./usage.mjs";

const D = (m, d) => Date.UTC(2026, m - 1, d, 12);
const low = (p, g, m) => (m ? { p, g, side: "low", m } : { p, g, side: "low" });
const base = (code, o) => ({
  v: 3, code, hostId: "h1", mode: "online", phase: "playing",
  lo0: 1, hi0: 100, lo: 1, hi: 100, bomb: "tok", penalty: "p",
  players: [], seats: [], turn: 0, spin: "", left: 0,
  history: [], over: false, loser: null, createdAt: D(9, 16), ...o
});

const ROOMS = [
  // finished, 3 players, one skip, one Double Trouble pair, two taunts
  base("AAAA", { players: ["Adrian", "Mei", "Raj"], seats: ["u1", "u2", "u3"],
    over: true, loser: 1,
    history: [ low(0, 10, "easy"), { p: 1, side: "skip" }, low(2, 20),
               low(0, 30), low(0, 40), { p: 1, g: 42, side: "boom", m: "no!!" } ] }),
  // finished, 2 players, one of them new
  base("BBBB", { players: ["Adrian", "Sam"], seats: ["u1", "u4"], over: true, loser: 0,
    history: [ low(0, 5), low(1, 60), { p: 0, g: 42, side: "boom" } ] }),
  // started but walked away from
  base("CCCC", { players: ["Mei", "Raj"], seats: ["u2", "u3"], createdAt: D(9, 18),
    history: [ low(0, 11), low(1, 70) ] }),
  // opened, nobody ever started it
  base("DDDD", { phase: "lobby", createdAt: D(9, 19) }),
  // a room from before v3: no spin field, no skips, still a real game
  { v: 2, code: "EEEE", hostId: "h1", mode: "online", phase: "playing",
    lo0: 1, hi0: 100, lo: 1, hi: 100, bomb: "tok", penalty: "p",
    players: ["Adrian", "Mei"], seats: ["u1", "u2"], turn: 0, over: true, loser: 1,
    createdAt: D(9, 14), history: [ low(0, 9), { p: 1, g: 42, side: "boom" } ] }
];

test("rooms are sorted into opened, played, finished and walked away from", () => {
  const s = summarise(ROOMS);
  assert.equal(s.rooms, 5);
  assert.equal(s.lobbiesNeverStarted, 1, "DDDD never started");
  assert.equal(s.started, 4);
  assert.equal(s.finished, 3, "AAAA, BBBB and the v2 room all detonated");
  assert.equal(s.abandonedMidGame, 1, "CCCC");
});

test("people are counted by device and by name, and they differ", () => {
  const s = summarise(ROOMS);
  assert.equal(s.players.size, 4, "u1 u2 u3 u4 across four games");
  assert.equal(s.names.size, 4, "Adrian, Mei, Raj, Sam");
  assert.equal(s.biggestTable, 3);
});

test("turns split into guesses and skips, and always add up", () => {
  const s = summarise(ROOMS);
  assert.equal(s.turns, 13);
  assert.equal(s.guesses, 12);
  assert.equal(s.skips, 1);
  assert.equal(s.guesses + s.skips, s.turns, "every turn is one or the other");
  assert.equal(s.longestGame, 6);
  assert.equal(s.trashTalk, 2);
});

test("Double Trouble is recovered from the log, not from a stored field", () => {
  // Nothing records that a pair happened. Two guesses in a row by the same
  // player, with no skip between, is the only evidence there is.
  const s = summarise(ROOMS);
  assert.equal(s.doubles, 1, "only Adrian's 30 then 40 in AAAA");

  // a skip between two of one player's guesses is not a pair
  const notAPair = summarise([ base("ZZZZ", { players: ["A", "B"], seats: ["x", "y"],
    history: [ low(0, 5), { p: 0, side: "skip" }, low(0, 6) ] }) ]);
  assert.equal(notAPair.doubles, 0);
});

test("a lobby that never started still counts as a day somebody tried", () => {
  const s = summarise(ROOMS);
  assert.equal(s.byDay.get("2026-09-16"), 2);
  assert.equal(s.byDay.get("2026-09-19"), 1, "the abandoned lobby");
  assert.equal(new Date(s.first).toISOString().slice(0, 10), "2026-09-14");
  assert.equal(new Date(s.last).toISOString().slice(0, 10), "2026-09-19");
});

test("no rooms at all reads as zero rather than crashing", () => {
  const s = summarise([]);
  assert.equal(s.rooms, 0);
  assert.equal(s.turns, 0);
  assert.doesNotThrow(() => render(s));
  assert.match(render(s), /Rooms opened\s+0/);
});

test("the report says out loud what it cannot see", () => {
  const out = render(summarise(ROOMS));
  assert.match(out, /Pass-the-phone and relay games are not counted/,
    "a usage number that hides its blind spot is worse than none");
  assert.match(out, /Games actually played 4/);
  assert.match(out, /skipped by wheel\s+1/);
  assert.match(out, /Double Trouble\s+1 pair\b/, "one pair, not one pairs");
});
