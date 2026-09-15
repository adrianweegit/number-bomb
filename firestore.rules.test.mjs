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

// The engine the page actually ships, pulled out of index.html. The point of
// the integration test at the bottom is that the rules and the engine cannot
// drift apart without one of them failing here.
const ENGINE = new Function(
  readFileSync(new URL("./index.html", import.meta.url), "utf8")
    .split("// ===== ENGINE START =====")[1]
    .split("// ===== ENGINE END =====")[0] + "\nreturn ENGINE;")();

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
  v: 3, code: ROOM, hostId: "alice", mode: "online", phase: "lobby",
  lo0: 1, hi0: 100, lo: 1, hi: 100,
  bomb: "scrambled-bomb-token", penalty: "eats the last piece",
  players: [], seats: [], turn: 0, spin: "", left: 0,
  history: [], over: false, loser: null, ...over
});
// A room mid-game. The player who is up has already spun an ordinary turn,
// which is the state almost every move test wants to start from.
const playing = (over = {}) => ({
  ...lobby(), phase: "playing", spin: "normal", left: 1,
  players: ["Alice", "Bob", "Cara"], seats: ["alice", "bob", "cara"], ...over
});
// The wheel resets as a turn is handed on.
const done = { spin: "", left: 0 };

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
                turn: 0, spin: "", left: 0, history: [], over: false, loser: null, lo: 1, hi: 100 };

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
const low30  = { ...done, lo: 30, hi: 100, turn: 1, history: [{ p: 0, g: 30, side: "low" }] };

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
      db("alice").doc(`rooms/${ROOM}`).update({ ...done, lo: g, hi: 55, turn: 1, history: [{ p: 0, g, side: "low" }] }),
      `guess ${g} should be refused`);
  }
  await assertSucceeds(
    db("alice").doc(`rooms/${ROOM}`).update({ ...done, lo: 31, hi: 55, turn: 1, history: [{ p: 0, g: 31, side: "low" }] }));
});

test("the bounds must move the way the claimed verdict says", async () => {
  await seed(playing());
  // says "too low" but drops the ceiling instead of raising the floor
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update(
    { ...done, lo: 1, hi: 30, turn: 1, history: [{ p: 0, g: 30, side: "low" }] }));
  // says "too low" but moves the floor somewhere other than the guess
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update(
    { ...done, lo: 90, hi: 100, turn: 1, history: [{ p: 0, g: 30, side: "low" }] }));
  // says "too high" but raises the floor
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update(
    { ...done, lo: 70, hi: 100, turn: 1, history: [{ p: 0, g: 70, side: "high" }] }));
  await assertSucceeds(db("alice").doc(`rooms/${ROOM}`).update(
    { ...done, lo: 1, hi: 70, turn: 1, history: [{ p: 0, g: 70, side: "high" }] }));
});

test("a move cannot skip a player or freeze the turn", async () => {
  await seed(playing());
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({ ...low30, turn: 2 }), "skipped Bob");
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({ ...low30, turn: 0 }), "kept the turn");
});

test("the log is append-only — an earlier move cannot be rewritten", async () => {
  await seed(playing({ lo: 30, turn: 1, history: [{ p: 0, g: 30, side: "low" }] }));
  await assertFails(db("bob").doc(`rooms/${ROOM}`).update({
    ...done, lo: 30, hi: 71, turn: 2,
    history: [{ p: 0, g: 99, side: "low" }, { p: 1, g: 71, side: "high" }]   // prefix altered
  }));
  await assertFails(db("bob").doc(`rooms/${ROOM}`).update({
    ...done, lo: 30, hi: 71, turn: 2, history: [{ p: 1, g: 71, side: "high" }]  // prefix dropped
  }));
  await assertSucceeds(db("bob").doc(`rooms/${ROOM}`).update({
    ...done, lo: 30, hi: 71, turn: 2,
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
    ...done, lo: 1, hi: 100, turn: 0, over: true, loser: 1, history: [{ p: 0, g: 42, side: "boom" }]
  }), "cannot blame someone else");
  await assertSucceeds(db("alice").doc(`rooms/${ROOM}`).update({
    ...done, lo: 1, hi: 100, turn: 0, over: true, loser: 0, history: [{ p: 0, g: 42, side: "boom" }]
  }));
});

test("no more moves once the bomb has gone off", async () => {
  await seed(playing({ ...done, over: true, loser: 0, turn: 0, history: [{ p: 0, g: 42, side: "boom" }] }));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({
    ...done, lo: 30, hi: 100, turn: 1, over: false, loser: null,
    history: [{ p: 0, g: 42, side: "boom" }, { p: 0, g: 30, side: "low" }]
  }));
});

// --- rematch and teardown ---------------------------------------------------
const finished = () => playing({ ...done, over: true, loser: 1, turn: 1, history: [{ p: 1, g: 42, side: "boom" }] });

test("only the host deals a rematch, and it must be a clean board", async () => {
  await seed(finished());
  const fresh = { ...done, lo: 1, hi: 100, bomb: "a-brand-new-token", turn: 2,
                  history: [], over: false, loser: null };
  await assertFails(db("bob").doc(`rooms/${ROOM}`).update(fresh));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({ ...fresh, history: [{ p: 0, g: 5, side: "low" }] }));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({ ...fresh, spin: "double", left: 2 }), "pre-spun");
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
    v: 3, code: ROOM, hostId: "alice", mode: "online", phase: "playing",
    lo0: 0, hi0: 400, lo, hi, bomb: "scrambled-bomb-token",
    penalty: "eats the last piece", players, seats,
    turn, spin: "normal", left: 1, history, over: false, loser: null
  });

  const mover = seats[turn];
  const g = lo + 1;
  const good = {
    ...done, lo: g, hi, turn: (turn + 1) % 2,
    history: [...history, { p: turn, g, side: "low" }]
  };
  // An honest move at depth 120 must still be allowed...
  await assertSucceeds(db(mover).doc(`rooms/${ROOM}`).update(good));

  // ...and a dishonest one at the same depth must still be refused on merit,
  // not merely because evaluation ran out of room.
  await env.clearFirestore();
  await seed({
    v: 3, code: ROOM, hostId: "alice", mode: "online", phase: "playing",
    lo0: 0, hi0: 400, lo, hi, bomb: "scrambled-bomb-token",
    penalty: "eats the last piece", players, seats,
    turn, spin: "normal", left: 1, history, over: false, loser: null
  });
  await assertFails(db(seats[(turn + 1) % 2]).doc(`rooms/${ROOM}`).update(good), "out of turn, at depth");

  // A spin at the same depth re-reads the whole log too, so it gets its own
  // budget check rather than riding on the move above.
  await env.clearFirestore();
  await seed({
    v: 3, code: ROOM, hostId: "alice", mode: "online", phase: "playing",
    lo0: 0, hi0: 400, lo, hi, bomb: "scrambled-bomb-token",
    penalty: "eats the last piece", players, seats,
    turn, spin: "", left: 0, history, over: false, loser: null
  });
  await assertSucceeds(db(mover).doc(`rooms/${ROOM}`).update({ spin: "double", left: 2 }));
  await assertFails(db(seats[(turn + 1) % 2]).doc(`rooms/${ROOM}`).update({ spin: "skip", left: 0 }),
    "spinning out of turn, at depth");
});

// --- the optional message ---------------------------------------------------
// Chat rides inside the move, so the rules are what stop one player writing a
// novel into a document the whole room has to download on every turn.

test("a move may carry a short message", async () => {
  await seed(playing());
  await assertSucceeds(db("alice").doc(`rooms/${ROOM}`).update({
    ...done, lo: 30, hi: 100, turn: 1,
    history: [{ p: 0, g: 30, side: "low", m: "no way it's this low" }]
  }));
});

test("an oversized or malformed message is refused", async () => {
  const move = m => ({ ...done, lo: 30, hi: 100, turn: 1, history: [{ p: 0, g: 30, side: "low", m }] });
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
    ...done, lo: 30, hi: 71, turn: 2,
    history: [{ p: 0, g: 30, side: "low", m: "adrian is a coward" },
              { p: 1, g: 71, side: "high" }]
  }));
});

// --- the lucky spin ---------------------------------------------------------
// The outcome is drawn on the client, because rules can validate a write but
// never compute one. What the rules CAN do is stop the wheel being used as a
// lever: spinning out of turn, spinning twice, claiming more guesses than the
// outcome allows, or moving the game while pretending to spin.

const unspun = (over = {}) => playing({ spin: "", left: 0, ...over });

test("only the player who is up may spin", async () => {
  await seed(unspun());
  await assertFails(db("bob").doc(`rooms/${ROOM}`).update({ spin: "normal", left: 1 }));
  await assertFails(db("cara").doc(`rooms/${ROOM}`).update({ spin: "skip", left: 0 }));
  await assertSucceeds(db("alice").doc(`rooms/${ROOM}`).update({ spin: "normal", left: 1 }));
});

test("a spin must claim exactly the guesses its outcome allows", async () => {
  for (const [label, patch] of [
    ["normal with two",   { spin: "normal", left: 2 }],
    ["normal with none",  { spin: "normal", left: 0 }],
    ["double with three", { spin: "double", left: 3 }],
    ["double with one",   { spin: "double", left: 1 }],
    ["skip with one",     { spin: "skip",   left: 1 }],
    ["an invented outcome", { spin: "jackpot", left: 9 }],
    ["guesses with no spin", { spin: "", left: 2 }]
  ]){
    await env.clearFirestore();
    await seed(unspun());
    await assertFails(db("alice").doc(`rooms/${ROOM}`).update(patch), label);
  }
});

test("spinning moves nothing else in the room", async () => {
  for (const [label, patch] of [
    ["moved the floor",  { lo: 30 }],
    ["moved the turn",   { turn: 1 }],
    ["wrote to the log", { history: [{ p: 0, g: 30, side: "low" }] }],
    ["re-armed the bomb", { bomb: "a-friendlier-bomb" }],
    ["ended the game",   { over: true, loser: 0 }]
  ]){
    await env.clearFirestore();
    await seed(unspun());
    await assertFails(
      db("alice").doc(`rooms/${ROOM}`).update({ spin: "double", left: 2, ...patch }), label);
  }
});

test("the wheel turns once per turn", async () => {
  await seed(playing({ spin: "normal", left: 1 }));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({ spin: "double", left: 2 }), "re-spun");
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({ spin: "skip", left: 0 }), "re-spun for a skip");
});

test("nobody guesses before the room says they have a guess", async () => {
  await seed(unspun());
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update(low30), "guessed without spinning");
  await env.clearFirestore();
  await seed(playing({ spin: "skip", left: 0 }));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update(low30), "guessed on a skip");
});

test("a skip hands the turn on without touching the range", async () => {
  await seed(playing({ spin: "skip", left: 0 }));
  await assertSucceeds(db("alice").doc(`rooms/${ROOM}`).update({
    ...done, lo: 1, hi: 100, turn: 1, history: [{ p: 0, side: "skip" }]
  }));
});

test("a skip cannot move the bounds, carry a number, or jump a player", async () => {
  for (const [label, patch] of [
    ["moved the floor",   { lo: 30, history: [{ p: 0, side: "skip" }] }],
    ["moved the ceiling", { hi: 70, history: [{ p: 0, side: "skip" }] }],
    ["smuggled a guess",  { history: [{ p: 0, g: 30, side: "skip" }] }],
    ["skipped Bob too",   { turn: 2, history: [{ p: 0, side: "skip" }] }],
    ["skipped for Bob",   { turn: 1, history: [{ p: 1, side: "skip" }] }],
    ["kept the wheel",    { turn: 1, spin: "skip", left: 0, history: [{ p: 0, side: "skip" }] }]
  ]){
    await env.clearFirestore();
    await seed(playing({ spin: "skip", left: 0 }));
    await assertFails(db("alice").doc(`rooms/${ROOM}`).update({
      ...done, lo: 1, hi: 100, turn: 1, ...patch
    }), label);
  }
});

test("a skip cannot be claimed without a skip on the wheel", async () => {
  for (const spin of ["", "normal", "double"]){
    await env.clearFirestore();
    await seed(playing({ spin, left: spin === "" ? 0 : spin === "double" ? 2 : 1 }));
    await assertFails(db("alice").doc(`rooms/${ROOM}`).update({
      ...done, lo: 1, hi: 100, turn: 1, history: [{ p: 0, side: "skip" }]
    }), `spin was "${spin}"`);
  }
});

test("a skip may carry a line of trash talk, within the same cap", async () => {
  await seed(playing({ spin: "skip", left: 0 }));
  await assertSucceeds(db("alice").doc(`rooms/${ROOM}`).update({
    ...done, lo: 1, hi: 100, turn: 1, history: [{ p: 0, side: "skip", m: "lucky escape" }]
  }));
  await env.clearFirestore();
  await seed(playing({ spin: "skip", left: 0 }));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({
    ...done, lo: 1, hi: 100, turn: 1, history: [{ p: 0, side: "skip", m: "x".repeat(81) }]
  }));
});

test("Double Trouble keeps the turn for the first guess and releases it on the second", async () => {
  await seed(playing({ spin: "double", left: 2 }));
  // handing the turn on after only one of the two guesses is refused
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({
    ...done, lo: 30, hi: 100, turn: 1, history: [{ p: 0, g: 30, side: "low" }]
  }), "left early");
  await assertSucceeds(db("alice").doc(`rooms/${ROOM}`).update({
    spin: "double", left: 1, lo: 30, hi: 100, turn: 0, history: [{ p: 0, g: 30, side: "low" }]
  }));
  await assertSucceeds(db("alice").doc(`rooms/${ROOM}`).update({
    ...done, lo: 30, hi: 70, turn: 1,
    history: [{ p: 0, g: 30, side: "low" }, { p: 0, g: 70, side: "high" }]
  }));
});

test("Double Trouble cannot be stretched into a third guess", async () => {
  await seed(playing({ spin: "double", left: 2 }));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({
    spin: "double", left: 2, lo: 30, hi: 100, turn: 0, history: [{ p: 0, g: 30, side: "low" }]
  }), "kept both guesses");
  await env.clearFirestore();
  await seed(playing({ spin: "double", left: 1, lo: 30, history: [{ p: 0, g: 30, side: "low" }] }));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({
    spin: "double", left: 1, lo: 40, hi: 100, turn: 0,
    history: [{ p: 0, g: 30, side: "low" }, { p: 0, g: 40, side: "low" }]
  }), "topped the wheel back up");
});

test("a detonation clears the wheel, second guess or not", async () => {
  await seed(playing({ spin: "double", left: 2 }));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({
    spin: "double", left: 1, lo: 1, hi: 100, turn: 0, over: true, loser: 0,
    history: [{ p: 0, g: 42, side: "boom" }]
  }), "a live wheel on a dead game");
  await assertSucceeds(db("alice").doc(`rooms/${ROOM}`).update({
    ...done, lo: 1, hi: 100, turn: 0, over: true, loser: 0,
    history: [{ p: 0, g: 42, side: "boom" }]
  }));
});

test("nobody spins once the bomb has gone off", async () => {
  await seed(playing({ ...done, over: true, loser: 0, turn: 0, history: [{ p: 0, g: 42, side: "boom" }] }));
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({ spin: "normal", left: 1 }));
});

test("a room opens and starts with the wheel at rest", async () => {
  await assertFails(db("alice").doc(`rooms/${ROOM}`).set(lobby({ spin: "double", left: 2 })));
  await assertSucceeds(db("alice").doc(`rooms/${ROOM}`).set(lobby()));
  await env.clearFirestore();
  await seed(lobby(), { alice: "Alice", bob: "Bob", cara: "Cara" });
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({ ...START, spin: "normal", left: 1 }));
  await assertSucceeds(db("alice").doc(`rooms/${ROOM}`).update(START));
});

// --- the version bump -------------------------------------------------------
// The spin changed the shape of a room, so a v2 game left running across the
// republish must stop dead rather than run on half-understood.
test("a room from before the spin is frozen, not half-played", async () => {
  const old = { ...playing(), v: 2 };
  delete old.spin; delete old.left;
  await seed(old);
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({
    ...done, lo: 30, hi: 100, turn: 1, history: [{ p: 0, g: 30, side: "low" }]
  }), "a v2 move");
  await assertFails(db("alice").doc(`rooms/${ROOM}`).update({ spin: "normal", left: 1 }), "a v2 spin");
  await env.clearFirestore();
  await assertFails(db("alice").doc(`rooms/${ROOM}`).set(lobby({ v: 2 })), "a v2 room");
});

// --- engine and rules, played end to end ------------------------------------
// Every write below is byte-for-byte what index.html sends. If a transition the
// engine allows is one the rules refuse, the game deadlocks on a real phone and
// this is where that shows up.
test("a whole game — spins, skips and doubles — is accepted move by move", async () => {
  const seats = ["alice", "bob", "cara"];
  const players = ["Alice", "Bob", "Cara"];
  const secret = 42;
  let st = ENGINE.createGame({ players, lo: 1, hi: 100, secret, penalty: "eats the last piece", mode: "online" });

  await seed({
    v: ENGINE.VERSION, code: ROOM, hostId: "alice", mode: "online", phase: "playing",
    lo0: st.lo0, hi0: st.hi0, lo: st.lo, hi: st.hi,
    bomb: ENGINE.hideNumber(secret), penalty: st.penalty,
    players, seats, turn: st.turn, spin: st.spin, left: st.left,
    history: st.history, over: st.over, loser: st.loser,
    createdAt: 1, updatedAt: 1
  });

  const outcomes = ["normal", "double", "skip", "double", "normal", "skip", "double", "normal"];
  const seen = new Set();
  let guard = 0;

  while (!st.over){
    assert.ok(guard < 200, "a game that never ends");
    // whoever is up sends the write; `st.turn` moves underneath us, so it is
    // read before each transition, not after
    const me = db(seats[st.turn]).doc(`rooms/${ROOM}`);

    // 1. the spin
    const outcome = outcomes[guard % outcomes.length];
    seen.add(outcome);
    st = ENGINE.applySpin(st, outcome);
    await assertSucceeds(me.update({ spin: st.spin, left: st.left, updatedAt: ++guard }));

    // 2. what the spin bought you
    if (st.spin === "skip"){
      st = ENGINE.endSkip(st, "not today");
      await assertSucceeds(me.update({
        turn: st.turn, history: st.history, spin: "", left: 0, updatedAt: ++guard
      }));
      continue;
    }
    while (!st.over && st.left > 0){
      const mover = seats[st.turn];
      const g = Math.floor((st.lo + st.hi) / 2) === st.lo
        ? st.lo + 1
        : Math.floor((st.lo + st.hi) / 2);
      st = ENGINE.applyGuess(st, g, "here goes");
      await assertSucceeds(db(mover).doc(`rooms/${ROOM}`).update({
        lo: st.lo, hi: st.hi, turn: st.turn, history: st.history,
        spin: st.spin, left: st.left, over: st.over, loser: st.loser, updatedAt: ++guard
      }));
    }
  }

  assert.deepEqual([...seen].sort(), ["double", "normal", "skip"], "all three outcomes were played");
  assert.equal(st.history[st.history.length - 1].side, "boom");
  assert.ok(st.history.some(h => h.side === "skip"), "a skip is in the log");

  // and the room the rules ended up holding is one the page can still read
  const snap = await db("alice").doc(`rooms/${ROOM}`).get();
  const back = ENGINE.fromDoc(snap.data());
  assert.equal(back.over, true);
  assert.equal(back.loser, st.loser);
  assert.deepEqual(back.history, st.history);

  // a rematch closes the loop
  const again = ENGINE.rematch(st, 60);
  await assertSucceeds(db("alice").doc(`rooms/${ROOM}`).update({
    lo: again.lo, hi: again.hi, bomb: ENGINE.hideNumber(60),
    turn: again.turn, spin: "", left: 0, history: [], over: false, loser: null, updatedAt: ++guard
  }));
});
