// Security-rule tests for Number Bomb, run against the Firestore emulator.
//
//   npm install && npm test
//
// These are the guard rails for a game anyone on the internet can join, so
// they are tested the way an attacker would probe them: every rule gets a
// case that should pass and a case that should be refused.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  initializeTestEnvironment, assertSucceeds, assertFails
} from "@firebase/rules-unit-testing";

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-number-bomb",
    firestore: {
      rules: readFileSync(new URL("./firestore.rules", import.meta.url), "utf8"),
      host: "127.0.0.1", port: 8181
    }
  });
});
after(async () => { await env?.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const db = uid => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();

const ROOM = "AB12";
const lobby = (over = {}) => ({
  v: 2, code: ROOM, hostId: "alice", mode: "online", phase: "lobby",
  lo0: 1, hi0: 100, lo: 1, hi: 100,
  bomb: "scrambled-bomb-token", penalty: "eats the last piece",
  players: [], seats: [], turn: 0, history: [], over: false, loser: null, ...over
});
const playing = (over = {}) => ({
  ...lobby(), phase: "playing",
  players: ["Alice", "Bob", "Cara"], seats: ["alice", "bob", "cara"], ...over
});

async function seed(data, seats){
  await env.withSecurityRulesDisabled(async ctx => {
    const d = ctx.firestore();
    await d.doc(`rooms/${ROOM}`).set(data);
    for (const [uid, name] of Object.entries(seats || {})){
      await d.doc(`rooms/${ROOM}/seats/${uid}`).set({ name, joinedAt: Date.now() });
    }
  });
}

// --- who is even allowed in -------------------------------------------------
test("a signed-in player reads a room; a signed-out one cannot", async () => {
  await seed(playing());
  await assertSucceeds(db("dave").doc(`rooms/${ROOM}`).get());
  await assertFails(anon().doc(`rooms/${ROOM}`).get());
  await assertFails(anon().doc(`rooms/${ROOM}`).set(playing()));
});

test("nothing outside /rooms is reachable", async () => {
  await assertFails(db("alice").doc("secrets/x").get());
  await assertFails(db("alice").doc("secrets/x").set({ a: 1 }));
});

// --- opening a room ---------------------------------------------------------
test("a host opens a room, but only in their own name", async () => {
  await assertSucceeds(db("alice").doc(`rooms/${ROOM}`).set(lobby()));
  await env.clearFirestore();
  await assertFails(db("mallory").doc(`rooms/${ROOM}`).set(lobby()), "hostId must be the caller");
});

test("a room cannot be opened mid-game or pre-loaded with a roster", async () => {
  await assertFails(db("alice").doc(`rooms/${ROOM}`).set(lobby({ phase: "playing" })));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).set(lobby({ seats: ["alice", "bob"] })));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).set(lobby({ history: [{ p: 0, g: 5, side: "low" }] })));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).set(lobby({ over: true, loser: 0 })));
});

test("a room needs a real range and a well-formed code", async () => {
  await assertFails(db("alice").doc(`rooms/${ROOM}`).set(lobby({ lo0: 10, hi0: 11, lo: 10, hi: 11 })));
  await assertFails(db("alice").doc("rooms/toolongcode").set({ ...lobby(), code: "toolongcode" }));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).set(lobby({ penalty: "" })));
});

// --- taking a seat ----------------------------------------------------------
test("you take your own seat and nobody else's", async () => {
  await seed(lobby());
  await assertSucceeds(db("bob").doc(`rooms/${ROOM}/seats/bob`).set({ name: "Bob", joinedAt: 1 }));
  await assertFails(db("bob").doc(`rooms/${ROOM}/seats/cara`).set({ name: "Cara", joinedAt: 1 }));
});

test("seats close once the game starts", async () => {
  await seed(playing());
  await assertFails(db("dave").doc(`rooms/${ROOM}/seats/dave`).set({ name: "Dave", joinedAt: 1 }));
});

test("a seat name has to be a sane string", async () => {
  await seed(lobby());
  await assertFails(db("bob").doc(`rooms/${ROOM}/seats/bob`).set({ name: "", joinedAt: 1 }));
  await assertFails(db("bob").doc(`rooms/${ROOM}/seats/bob`).set({ name: "x".repeat(19), joinedAt: 1 }));
  await assertFails(db("bob").doc(`rooms/${ROOM}/seats/bob`).set({ name: 42, joinedAt: 1 }));
});

test("you can give up your own seat", async () => {
  await seed(lobby(), { bob: "Bob" });
  await assertFails(db("cara").doc(`rooms/${ROOM}/seats/bob`).delete());
  await assertSucceeds(db("bob").doc(`rooms/${ROOM}/seats/bob`).delete());
});

// --- starting ---------------------------------------------------------------
const START = { phase: "playing", seats: ["alice", "bob", "cara"], players: ["Alice", "Bob", "Cara"],
                turn: 0, history: [], over: false, loser: null, lo: 1, hi: 100 };

test("only the host starts the game", async () => {
  await seed(lobby(), { alice: "Alice", bob: "Bob", cara: "Cara" });
  await assertFails(db("bob").doc(`rooms/${ROOM}`).update(START));
  await assertSucceeds(db("alice").doc(`rooms/${ROOM}`).update(START));
});

test("a game cannot start one-handed, or with a swapped bomb", async () => {
  await seed(lobby(), { alice: "Alice" });
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({ ...START, seats: ["alice"], players: ["Alice"] }));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({ ...START, bomb: "a-bomb-i-just-picked" }));
});

// --- taking a turn ----------------------------------------------------------
const low30  = { lo: 30, hi: 100, turn: 1, history: [{ p: 0, g: 30, side: "low" }] };

test("the player whose turn it is may move; nobody else may", async () => {
  await seed(playing());
  await assertFails(db("bob").doc(`rooms/${ROOM}`).update({ ...low30, history: [{ p: 1, g: 30, side: "low" }] }));
  await assertFails(db("cara").doc(`rooms/${ROOM}`).update(low30));
  await assertSucceeds(db("alice").doc(`rooms/${ROOM}`).update(low30));
});

test("a guess must sit strictly inside the live range", async () => {
  await seed(playing({ lo: 30, hi: 55, turn: 0 }));
  for (const g of [30, 55, 29, 56, 1000]){
    await assertFails(
      db("alice").doc(`rooms/${ROOM}`).update({ lo: g, hi: 55, turn: 1, history: [{ p: 0, g, side: "low" }] }),
      `guess ${g} should be refused`);
  }
  await assertSucceeds(
    db("alice").doc(`rooms/${ROOM}`).update({ lo: 31, hi: 55, turn: 1, history: [{ p: 0, g: 31, side: "low" }] }));
});

test("the bounds must move the way the claimed verdict says", async () => {
  await seed(playing());
  // says "too low" but drops the ceiling instead of raising the floor
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update(
    { lo: 1, hi: 30, turn: 1, history: [{ p: 0, g: 30, side: "low" }] }));
  // says "too low" but moves the floor somewhere other than the guess
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update(
    { lo: 90, hi: 100, turn: 1, history: [{ p: 0, g: 30, side: "low" }] }));
  // says "too high" but raises the floor
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update(
    { lo: 70, hi: 100, turn: 1, history: [{ p: 0, g: 70, side: "high" }] }));
  await assertSucceeds(db("alice").doc(`rooms/${ROOM}`).update(
    { lo: 1, hi: 70, turn: 1, history: [{ p: 0, g: 70, side: "high" }] }));
});

test("a move cannot skip a player or freeze the turn", async () => {
  await seed(playing());
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({ ...low30, turn: 2 }), "skipped Bob");
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({ ...low30, turn: 0 }), "kept the turn");
});

test("the log is append-only — an earlier move cannot be rewritten", async () => {
  await seed(playing({ lo: 30, turn: 1, history: [{ p: 0, g: 30, side: "low" }] }));
  await assertFails(db("bob").doc(`rooms/${ROOM}`).update({
    lo: 30, hi: 71, turn: 2,
    history: [{ p: 0, g: 99, side: "low" }, { p: 1, g: 71, side: "high" }]   // prefix altered
  }));
  await assertFails(db("bob").doc(`rooms/${ROOM}`).update({
    lo: 30, hi: 71, turn: 2, history: [{ p: 1, g: 71, side: "high" }]        // prefix dropped
  }));
  await assertSucceeds(db("bob").doc(`rooms/${ROOM}`).update({
    lo: 30, hi: 71, turn: 2,
    history: [{ p: 0, g: 30, side: "low" }, { p: 1, g: 71, side: "high" }]
  }));
});

test("a mover cannot re-arm the bomb, edit the roster or change the stakes", async () => {
  await seed(playing());
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({ ...low30, bomb: "a-friendlier-bomb" }));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({ ...low30, seats: ["alice", "alice", "cara"] }));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({ ...low30, players: ["A", "B", "C", "D"] }));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({ ...low30, penalty: "does nothing at all" }));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({ ...low30, hostId: "alice2" }));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({ ...low30, lo0: -500 }));
});

// --- detonation -------------------------------------------------------------
test("a detonation pins the guesser as the loser and stops the game", async () => {
  await seed(playing());
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({
    lo: 1, hi: 100, turn: 0, over: true, loser: 1, history: [{ p: 0, g: 42, side: "boom" }]
  }), "cannot blame someone else");
  await assertSucceeds(db("alice").doc(`rooms/${ROOM}`).update({
    lo: 1, hi: 100, turn: 0, over: true, loser: 0, history: [{ p: 0, g: 42, side: "boom" }]
  }));
});

test("no more moves once the bomb has gone off", async () => {
  await seed(playing({ over: true, loser: 0, turn: 0, history: [{ p: 0, g: 42, side: "boom" }] }));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({
    lo: 30, hi: 100, turn: 1, over: false, loser: null,
    history: [{ p: 0, g: 42, side: "boom" }, { p: 0, g: 30, side: "low" }]
  }));
});

// --- rematch and teardown ---------------------------------------------------
const finished = () => playing({ over: true, loser: 1, turn: 1, history: [{ p: 1, g: 42, side: "boom" }] });

test("only the host deals a rematch, and it must be a clean board", async () => {
  await seed(finished());
  const fresh = { lo: 1, hi: 100, bomb: "a-brand-new-token", turn: 2,
                  history: [], over: false, loser: null };
  await assertFails(db("bob").doc(`rooms/${ROOM}`).update(fresh));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({ ...fresh, history: [{ p: 0, g: 5, side: "low" }] }));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({ ...fresh, turn: 9 }));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({ ...fresh, seats: ["alice", "bob"] }));
  await assertSucceeds(db("alice").doc(`rooms/${ROOM}`).update(fresh));
});

test("only the host clears the room away", async () => {
  await seed(playing());
  await assertFails(db("bob").doc(`rooms/${ROOM}`).delete());
  await assertSucceeds(db("alice").doc(`rooms/${ROOM}`).delete());
});

// --- the expression budget --------------------------------------------------
// Rules are capped at 1000 expression evaluations per request, and the cost of
// a move grows with the log. A rule that passes the short tests above can still
// exhaust the budget deep into a real game and start denying honest moves, so
// this plays a long one and checks the LAST move is still evaluated on merit.
test("a long game still evaluates — the rules stay inside the expression budget", async () => {
  const seats = ["alice", "bob"], players = ["Alice", "Bob"];
  // Walk 1..400 upward one number at a time: the slowest legal game there is.
  let history = [], lo = 0, hi = 400, turn = 0;
  for (let g = 1; g <= 120; g++){
    history.push({ p: turn, g, side: "low" });
    lo = g; turn = (turn + 1) % 2;
  }
  await seed({
    v: 2, code: ROOM, hostId: "alice", mode: "online", phase: "playing",
    lo0: 0, hi0: 400, lo, hi, bomb: "scrambled-bomb-token",
    penalty: "eats the last piece", players, seats,
    turn, history, over: false, loser: null
  });

  const mover = seats[turn];
  const g = lo + 1;
  const good = {
    lo: g, hi, turn: (turn + 1) % 2,
    history: [...history, { p: turn, g, side: "low" }]
  };
  // An honest move at depth 120 must still be allowed...
  await assertSucceeds(db(mover).doc(`rooms/${ROOM}`).update(good));

  // ...and a dishonest one at the same depth must still be refused on merit,
  // not merely because evaluation ran out of room.
  await env.clearFirestore();
  await seed({
    v: 2, code: ROOM, hostId: "alice", mode: "online", phase: "playing",
    lo0: 0, hi0: 400, lo, hi, bomb: "scrambled-bomb-token",
    penalty: "eats the last piece", players, seats,
    turn, history, over: false, loser: null
  });
  await assertFails(db(seats[(turn + 1) % 2]).doc(`rooms/${ROOM}`).update(good), "out of turn, at depth");
});

// --- the optional message ---------------------------------------------------
// Chat rides inside the move, so the rules are what stop one player writing a
// novel into a document the whole room has to download on every turn.

test("a move may carry a short message", async () => {
  await seed(playing());
  await assertSucceeds(db("alice").doc(`rooms/${ROOM}`).update({
    lo: 30, hi: 100, turn: 1,
    history: [{ p: 0, g: 30, side: "low", m: "no way it's this low" }]
  }));
});

test("an oversized or malformed message is refused", async () => {
  const move = m => ({ lo: 30, hi: 100, turn: 1, history: [{ p: 0, g: 30, side: "low", m }] });
  for (const [label, m] of [
    ["81 characters", "x".repeat(81)],
    ["a kilobyte",    "x".repeat(1024)],
    ["empty string",  ""],
    ["a number",      42],
    ["a list",        ["a"]],
    ["a map",         { a: 1 }]
  ]) {
    await env.clearFirestore();
    await seed(playing());
    await assertFails(db("alice").doc(`rooms/${ROOM}`).update(move(m)), label);
  }
  await env.clearFirestore();
  await seed(playing());
  await assertSucceeds(db("alice").doc(`rooms/${ROOM}`).update(move("x".repeat(80))), "80 is the cap");
});

test("a message cannot be slipped onto someone else's move", async () => {
  await seed(playing({ lo: 30, turn: 1, history: [{ p: 0, g: 30, side: "low" }] }));
  // Bob is up; he must not edit Adrian's earlier move while appending his own.
  await assertFails(db("bob").doc(`rooms/${ROOM}`).update({
    lo: 30, hi: 71, turn: 2,
    history: [{ p: 0, g: 30, side: "low", m: "adrian is a coward" },
              { p: 1, g: 71, side: "high" }]
  }));
});
