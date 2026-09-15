// Rules tests for Number Bomb.
// The engine lives inside index.html so the game stays one shareable file;
// this pulls the marked block out and exercises it directly.
//
//   node --test engine.test.mjs
//
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const source = html.split("// ===== ENGINE START =====")[1].split("// ===== ENGINE END =====")[0];
const ENGINE = new Function(`${source}\nreturn ENGINE;`)();

const game = (over = {}) => ENGINE.createGame({
  players: ["Adrian", "Mei", "Raj"], lo: 1, hi: 100, secret: 42,
  penalty: "eats the last piece on the dish", ...over
});

test("setup rejects a bomb sitting on a boundary", () => {
  assert.throws(() => game({ secret: 1 }), /strictly inside/);
  assert.throws(() => game({ secret: 100 }), /strictly inside/);
  assert.doesNotThrow(() => game({ secret: 2 }));
  assert.doesNotThrow(() => game({ secret: 99 }));
});

test("setup rejects unplayable ranges and short rosters", () => {
  assert.throws(() => game({ lo: 10, hi: 11, secret: 10 }), /at least one guessable/);
  assert.throws(() => ENGINE.createGame({ players: ["Solo"], lo: 1, hi: 100, secret: 42 }), /at least 2/);
});

test("a low guess raises the floor, a high guess drops the ceiling", () => {
  let s = game();
  s = ENGINE.applyGuess(s, 30);
  assert.deepEqual([s.lo, s.hi], [30, 100]);
  s = ENGINE.applyGuess(s, 55);
  assert.deepEqual([s.lo, s.hi], [30, 55]);
  assert.equal(s.over, false);
});

test("guesses outside the live range are refused and do not burn a turn", () => {
  let s = ENGINE.applyGuess(game(), 30);          // range is now 30-100, Mei's turn
  assert.equal(s.turn, 1);
  for (const bad of [30, 100, 29, 101, "", "12.5", "abc"]) {
    const check = ENGINE.validateGuess(s, bad);
    assert.equal(check.ok, false, `${JSON.stringify(bad)} should be refused`);
    assert.throws(() => ENGINE.applyGuess(s, bad));
  }
  assert.equal(s.turn, 1, "turn order untouched by refused guesses");
});

test("turn order loops through the players", () => {
  let s = game();
  const seen = [];
  for (const g of [10, 20, 30, 35]) { seen.push(s.turn); s = ENGINE.applyGuess(s, g); }
  assert.deepEqual(seen, [0, 1, 2, 0]);
});

test("hitting the bomb ends the game and pins the loser", () => {
  let s = ENGINE.applyGuess(game(), 30);          // Mei is up
  s = ENGINE.applyGuess(s, 42);
  assert.equal(s.over, true);
  assert.equal(s.loser, 1);
  assert.equal(s.players[s.loser], "Mei");
  assert.equal(s.history.at(-1).side, "boom");
  assert.equal(ENGINE.validateGuess(s, 41).ok, false, "no play after the bang");
});

test("the range always shrinks to a forced detonation — never a deadlock", () => {
  for (const secret of [2, 17, 50, 83, 99]) {
    let s = game({ secret });
    let guesses = 0;
    while (!s.over) {
      assert.ok(s.lo < secret && secret < s.hi, "bomb must stay strictly inside the live range");
      assert.ok(ENGINE.remaining(s) >= 1, "a legal guess must always exist");
      // Guess the lowest legal number every time — the slowest possible walk.
      s = ENGINE.applyGuess(s, s.lo + 1);
      assert.ok(++guesses <= 200, "game must terminate");
    }
    assert.equal(s.history.at(-1).g, secret);
  }
});

test("remaining counts only guessable numbers", () => {
  assert.equal(ENGINE.remaining({ lo: 1, hi: 100 }), 98);
  assert.equal(ENGINE.remaining({ lo: 41, hi: 43 }), 1);
});

test("a rematch keeps the crew and stakes, and the loser's neighbour leads", () => {
  let s = ENGINE.applyGuess(game(), 30);
  s = ENGINE.applyGuess(s, 42);                    // Mei (index 1) loses
  const next = ENGINE.rematch(s, 77);
  assert.equal(next.turn, 2, "play resumes after the loser");
  assert.deepEqual(next.players, s.players);
  assert.equal(next.penalty, s.penalty);
  assert.deepEqual([next.lo, next.hi], [1, 100]);
  assert.equal(next.history.length, 0);
  assert.equal(next.over, false);
});

test("random secrets always land strictly inside the range", () => {
  for (let i = 0; i < 400; i++) {
    const n = ENGINE.randomSecret(1, 4);
    assert.ok(n > 1 && n < 4, `${n} out of bounds`);
  }
});

test("state survives a round trip through a share link", () => {
  let s = ENGINE.applyGuess(game({ players: ["Adrian", "Méi 🐉", "Raj"] }), 30);
  const back = ENGINE.decodeState(ENGINE.encodeState(s));
  assert.deepEqual(back, s);
  assert.equal(back.players[1], "Méi 🐉", "unicode names survive");
});

test("the share link does not leak the bomb in plain sight", () => {
  const token = ENGINE.encodeState(game({ secret: 42 }));
  assert.ok(!/eats the last piece/.test(token), "payload is not readable text");
  assert.ok(!/"secret"/.test(token));
});

test("a damaged or foreign link is rejected rather than half-loaded", () => {
  for (const junk of ["", "not-a-token", "###", ENGINE.encodeState({ v: 99, players: ["a", "b"] })]) {
    assert.equal(ENGINE.decodeState(junk), null);
  }
});

// --- the link/code trust boundary ------------------------------------------
// A turn code arrives from someone else's phone. Anything that fails a check is
// discarded outright, because a half-loaded game is worse than no game: it can
// deadlock, or accept guesses it should refuse.

const tampered = (patch) => {
  const s = { ...game(), ...patch };
  return ENGINE.decodeState(ENGINE.encodeState(s));
};

test("a tampered code that would deadlock the game is rejected", () => {
  // lo and hi crossed: remaining() would be 0 with the game still live, so
  // every guess is refused forever.
  assert.equal(tampered({ lo: 10, hi: 9 }), null);
  assert.equal(tampered({ lo: 50, hi: 50 }), null);
});

test("a tampered code with non-numeric bounds is rejected", () => {
  // Left unchecked these make remaining() NaN and every integer 'legal'.
  for (const patch of [{ lo: null }, { hi: "100" }, { secret: 1.5 }, { lo0: undefined }]) {
    assert.equal(tampered(patch), null, JSON.stringify(patch));
  }
});

test("a code whose bomb escaped the live range is rejected", () => {
  assert.equal(tampered({ secret: 500 }), null);
  assert.equal(tampered({ secret: 1 }), null, "bomb on the floor breaks termination");
});

test("a code with an out-of-range turn or loser is rejected", () => {
  assert.equal(tampered({ turn: 7 }), null);
  assert.equal(tampered({ turn: -1 }), null);
  assert.equal(tampered({ over: true, loser: 9 }), null);
  assert.equal(tampered({ over: false, loser: 0 }), null, "a live game has no loser");
});

test("a code with a malformed roster or history is rejected", () => {
  assert.equal(tampered({ players: ["Solo"] }), null);
  assert.equal(tampered({ players: ["Adrian", ""] }), null);
  assert.equal(tampered({ players: ["Adrian", 42] }), null);
  assert.equal(tampered({ history: [{ p: 0, g: 30, side: "sideways" }] }), null);
  assert.equal(tampered({ history: [{ p: 99, g: 30, side: "low" }] }), null);
  assert.equal(tampered({ history: "nope" }), null);
});

test("a truncated code is rejected rather than half-loaded", () => {
  const token = ENGINE.encodeState(game());
  for (const cut of [0.25, 0.5, 0.75, 0.9]) {
    assert.equal(ENGINE.decodeState(token.slice(0, Math.floor(token.length * cut))), null);
  }
});

test("an honest code still survives every check", () => {
  let s = game();
  for (const g of [30, 71, 38]) s = ENGINE.applyGuess(s, g);
  const back = ENGINE.decodeState(ENGINE.encodeState(s));
  assert.deepEqual(back, s);
  assert.equal(ENGINE.isValidState(back), true);
});

test("rosters beyond the cap are refused at both ends", () => {
  const many = Array.from({ length: ENGINE.MAX_PLAYERS + 1 }, (_, i) => "P" + i);
  assert.throws(() => game({ players: many }), /At most/);
  assert.equal(tampered({ players: many }), null);
});

// --- the shared room document ----------------------------------------------
// Synced play keeps the game in one document every phone reads and writes.
// The bomb must never sit in it as a plain number.

test("the room document never carries the bomb as a readable number", () => {
  const doc = ENGINE.toDoc(game({ secret: 42 }), { code: "4F2K", phase: "playing" });
  const json = JSON.stringify(doc);
  assert.equal("secret" in doc, false, "the raw field must be gone");
  assert.ok(!/\b42\b/.test(json), "42 must not appear anywhere in the document");
  assert.ok(typeof doc.bomb === "string" && doc.bomb.length > 0);
});

test("two rooms with the same bomb do not share a bomb string", () => {
  // A salt per room stops anyone matching rooms by eye, or replaying one.
  const a = ENGINE.toDoc(game({ secret: 42 })).bomb;
  const b = ENGINE.toDoc(game({ secret: 42 })).bomb;
  assert.notEqual(a, b);
  assert.equal(ENGINE.showNumber(a), 42);
  assert.equal(ENGINE.showNumber(b), 42);
});

test("a room document round-trips into a playable state", () => {
  let s = game();
  for (const g of [30, 71, 38]) s = ENGINE.applyGuess(s, g);
  const doc = ENGINE.toDoc(s, { code: "4F2K", phase: "playing", hostId: "s1", seats: ["s1", "s2", "s3"] });
  const back = ENGINE.fromDoc(doc);
  assert.equal(back.secret, 42);
  assert.deepEqual(back.history, s.history);
  assert.deepEqual([back.lo, back.hi], [s.lo, s.hi]);
  assert.deepEqual(back.seats, ["s1", "s2", "s3"], "room fields survive alongside the rules");
  assert.equal(back.code, "4F2K");
});

test("a room document that fails the rules is refused, not half-loaded", () => {
  const good = ENGINE.toDoc(game(), { phase: "playing" });
  assert.ok(ENGINE.fromDoc(good));
  assert.equal(ENGINE.fromDoc({ ...good, bomb: "not-a-bomb" }), null);
  assert.equal(ENGINE.fromDoc({ ...good, bomb: undefined }), null);
  assert.equal(ENGINE.fromDoc({ ...good, lo: 90 }), null, "bomb outside the live range");
  assert.equal(ENGINE.fromDoc({ ...good, turn: 99 }), null);
  assert.equal(ENGINE.fromDoc({ ...good, players: [] }), null);
  assert.equal(ENGINE.fromDoc(null), null);
  assert.equal(ENGINE.fromDoc("nope"), null);
});

test("online is a real mode and survives validation", () => {
  const s = game({ mode: "online" });
  assert.equal(s.mode, "online");
  assert.ok(ENGINE.isValidState(s));
  assert.equal(ENGINE.fromDoc({ ...ENGINE.toDoc(s), mode: "sideways" }), null);
});

test("room codes avoid characters people misread", () => {
  assert.equal(/[IO01]/.test(ENGINE.CODE_ALPHABET), false);
  const seen = new Set();
  for (let i = 0; i < 500; i++){
    const c = ENGINE.newRoomCode();
    assert.match(c, /^[A-Z0-9]{4}$/);
    assert.equal(/[IO01]/.test(c), false);
    seen.add(c);
  }
  assert.ok(seen.size > 400, "codes should not collide constantly");
});

test("a rematch in a room keeps the crew and re-arms a fresh bomb", () => {
  let s = ENGINE.applyGuess(game(), 30);
  s = ENGINE.applyGuess(s, 42);                     // Mei (1) loses
  s.seats = ["s1", "s2", "s3"];
  const next = ENGINE.rematch(s, 77);
  const doc = ENGINE.toDoc(next, { seats: s.seats });
  const back = ENGINE.fromDoc(doc);
  assert.equal(back.secret, 77);
  assert.deepEqual(back.seats, s.seats, "seats survive so turn order still maps to phones");
  assert.equal(back.turn, 2);
  assert.equal(back.history.length, 0);
});

// --- a line of chat with the move -------------------------------------------
// The message travels inside the move, so it crosses every boundary the move
// already crosses: the shared room document and the pasteable turn codes.

test("a guess can carry a message, and usually does not", () => {
  let s = ENGINE.applyGuess(game(), 30, "no way it's this low");
  assert.equal(s.history.at(-1).m, "no way it's this low");
  s = ENGINE.applyGuess(s, 71);
  assert.equal("m" in s.history.at(-1), false, "a quiet move carries no field at all");
});

test("blank and whitespace-only messages leave no field behind", () => {
  for (const blank of ["", "   ", "\n\t ", null, undefined, 42, {}]) {
    const s = ENGINE.applyGuess(game(), 30, blank);
    assert.equal("m" in s.history.at(-1), false, JSON.stringify(blank));
  }
});

test("a message is trimmed and capped rather than rejected", () => {
  const s = ENGINE.applyGuess(game(), 30, "   padded out   ");
  assert.equal(s.history.at(-1).m, "padded out");
  const long = ENGINE.applyGuess(game(), 30, "x".repeat(500));
  assert.equal(long.history.at(-1).m.length, ENGINE.MAX_MESSAGE);
});

test("an oversized or malformed message in a shared game is refused", () => {
  const base = ENGINE.applyGuess(game(), 30, "fine");
  assert.ok(ENGINE.decodeState(ENGINE.encodeState(base)), "an honest one survives");
  const bad = m => {
    const s = { ...base, history: [{ p: 0, g: 30, side: "low", m }] };
    return ENGINE.decodeState(ENGINE.encodeState(s));
  };
  assert.equal(bad("x".repeat(ENGINE.MAX_MESSAGE + 1)), null, "over the cap");
  assert.equal(bad(""), null, "empty string should never be stored");
  assert.equal(bad(12345), null, "not a string");
  assert.equal(bad({ toString: () => "x" }), null, "not a string");
});

test("messages survive a turn code round trip", () => {
  let s = ENGINE.applyGuess(game({ players: ["Adrian", "Umbrella"] }), 30, "over to you 😈");
  s = ENGINE.applyGuess(s, 71, "rude");
  const back = ENGINE.decodeState(ENGINE.encodeState(s));
  assert.deepEqual(back.history.map(e => e.m), ["over to you 😈", "rude"]);
});

test("a message cannot smuggle markup into the log", () => {
  // The log renders with textContent, so this must survive as literal text
  // rather than being sanitised away — losing it silently would hide a bug.
  const evil = '<img src=x onerror="alert(1)">';
  const s = ENGINE.applyGuess(game(), 30, evil);
  assert.equal(s.history.at(-1).m, evil);
  assert.equal(ENGINE.decodeState(ENGINE.encodeState(s)).history.at(-1).m, evil);
});

// --- the number the odds preview is built from ------------------------------
test("remaining() is hi minus lo minus one at the edge", () => {
  // The preview says "1 in N" and switches to "One number left" off this
  // count. Computing it from hi - lo instead would fire both a turn late.
  assert.equal(ENGINE.remaining({ lo: 30, hi: 32 }), 1, "30–32 leaves only 31");
  assert.equal(ENGINE.remaining({ lo: 30, hi: 31 }), 0, "adjacent bounds leave nothing");
});
