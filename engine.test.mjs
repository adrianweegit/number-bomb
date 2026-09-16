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

// Every turn now opens with a lucky spin. Most of these tests are about what
// happens after one, so `play` takes the ordinary outcome and gets out of the
// way; the spin itself has its own tests further down.
const spun = s => s.spin === "" ? ENGINE.applySpin(s, "normal") : s;
const play = (s, g, m) => ENGINE.applyGuess(spun(s), g, m);

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
  s = play(s, 30);
  assert.deepEqual([s.lo, s.hi], [30, 100]);
  s = play(s, 55);
  assert.deepEqual([s.lo, s.hi], [30, 55]);
  assert.equal(s.over, false);
});

test("guesses outside the live range are refused and do not burn a turn", () => {
  let s = spun(play(game(), 30));     // range is now 30-100, Mei's turn, spun
  assert.equal(s.turn, 1);
  assert.equal(ENGINE.validateGuess(s, 55).ok, true, "a legal guess is still legal");
  for (const bad of [30, 100, 29, 101, "", "12.5", "abc"]) {
    const check = ENGINE.validateGuess(s, bad);
    assert.equal(check.ok, false, `${JSON.stringify(bad)} should be refused`);
    assert.throws(() => play(s, bad));
  }
  assert.equal(s.turn, 1, "turn order untouched by refused guesses");
});

test("turn order loops through the players", () => {
  let s = game();
  const seen = [];
  for (const g of [10, 20, 30, 35]) { seen.push(s.turn); s = play(s, g); }
  assert.deepEqual(seen, [0, 1, 2, 0]);
});

test("hitting the bomb ends the game and pins the loser", () => {
  let s = play(game(), 30);          // Mei is up
  s = play(s, 42);
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
      s = play(s, s.lo + 1);
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
  let s = play(game(), 30);
  s = play(s, 42);                    // Mei (index 1) loses
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
  let s = play(game({ players: ["Adrian", "Méi 🐉", "Raj"] }), 30);
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
  assert.equal(tampered({ history: [{ p: 0, side: "low" }] }), null, "a guess-less low");
  assert.equal(tampered({ history: [{ p: 0, g: 30, side: "skip" }] }), null, "a skip with a guess");
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
  for (const g of [30, 71, 38]) s = play(s, g);
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
  for (const g of [30, 71, 38]) s = play(s, g);
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
  let s = play(game(), 30);
  s = play(s, 42);                     // Mei (1) loses
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
  let s = play(game(), 30, "no way it's this low");
  assert.equal(s.history.at(-1).m, "no way it's this low");
  s = play(s, 71);
  assert.equal("m" in s.history.at(-1), false, "a quiet move carries no field at all");
});

test("blank and whitespace-only messages leave no field behind", () => {
  for (const blank of ["", "   ", "\n\t ", null, undefined, 42, {}]) {
    const s = play(game(), 30, blank);
    assert.equal("m" in s.history.at(-1), false, JSON.stringify(blank));
  }
});

test("a message is trimmed and capped rather than rejected", () => {
  const s = play(game(), 30, "   padded out   ");
  assert.equal(s.history.at(-1).m, "padded out");
  const long = play(game(), 30, "x".repeat(500));
  assert.equal(long.history.at(-1).m.length, ENGINE.MAX_MESSAGE);
});

test("an oversized or malformed message in a shared game is refused", () => {
  const base = play(game(), 30, "fine");
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
  let s = play(game({ players: ["Adrian", "Umbrella"] }), 30, "over to you 😈");
  s = play(s, 71, "rude");
  const back = ENGINE.decodeState(ENGINE.encodeState(s));
  assert.deepEqual(back.history.map(e => e.m), ["over to you 😈", "rude"]);
});

test("a message cannot smuggle markup into the log", () => {
  // The log renders with textContent, so this must survive as literal text
  // rather than being sanitised away — losing it silently would hide a bug.
  const evil = '<img src=x onerror="alert(1)">';
  const s = play(game(), 30, evil);
  assert.equal(s.history.at(-1).m, evil);
  assert.equal(ENGINE.decodeState(ENGINE.encodeState(s)).history.at(-1).m, evil);
});

// ---------------------------------------------------------------------------
// The lucky spin
// ---------------------------------------------------------------------------

test("nobody may guess before the wheel has been pulled", () => {
  const s = game();
  assert.equal(s.spin, "");
  assert.equal(s.left, 0);
  const check = ENGINE.validateGuess(s, 30);
  assert.equal(check.ok, false);
  assert.match(check.reason, /Spin first/);
  assert.throws(() => ENGINE.applyGuess(s, 30), /Spin first/);
});

test("Business As Usual is one guess, then the turn moves on", () => {
  let s = ENGINE.applySpin(game(), "normal");
  assert.deepEqual([s.spin, s.left, s.turn], ["normal", 1, 0]);
  s = ENGINE.applyGuess(s, 30);
  assert.deepEqual([s.spin, s.left, s.turn], ["", 0, 1], "wheel resets for the next player");
  assert.equal(ENGINE.validateGuess(s, 40).ok, false, "and they have to spin too");
});

test("Double Trouble is two guesses on one spin, with no second spin", () => {
  let s = ENGINE.applySpin(game(), "double");
  assert.deepEqual([s.spin, s.left], ["double", 2]);
  s = ENGINE.applyGuess(s, 20);
  assert.deepEqual([s.turn, s.spin, s.left], [0, "double", 1], "same player, still owed a guess");
  assert.equal(ENGINE.validateGuess(s, 30).ok, true, "the second guess needs no spin");
  assert.throws(() => ENGINE.applySpin(s, "normal"), /already spun/);
  s = ENGINE.applyGuess(s, 30);
  assert.deepEqual([s.turn, s.spin, s.left], [1, "", 0], "now it is Mei's turn");
  assert.deepEqual([s.lo, s.hi], [30, 100], "both guesses moved the floor");
  assert.equal(s.history.length, 2);
});

test("Skip This Turn ends the turn and leaves the range alone", () => {
  const before = ENGINE.applySpin(game(), "skip");
  assert.deepEqual([before.spin, before.left], ["skip", 0]);
  assert.equal(ENGINE.validateGuess(before, 30).ok, false, "no guess is legal on a skip");
  const s = ENGINE.endSkip(before);
  assert.deepEqual([s.lo, s.hi], [1, 100], "bounds untouched");
  assert.equal(s.turn, 1, "the next player is up");
  assert.deepEqual([s.spin, s.left], ["", 0], "and they spin for themselves");
  assert.equal(ENGINE.remaining(s), 98);
});

test("a skipped turn is logged, so the jump in turn order is explained", () => {
  const s = ENGINE.endSkip(ENGINE.applySpin(game(), "skip"));
  assert.deepEqual(s.history, [{ p: 0, side: "skip" }]);
  assert.equal(s.history[0].g, undefined, "a skip carries no number");
  assert.equal(ENGINE.isValidState(s), true);
});

test("a skip can carry trash talk, and a blank one leaves no field", () => {
  const said = ENGINE.endSkip(ENGINE.applySpin(game(), "skip"), "  lucky escape  ");
  assert.equal(said.history[0].m, "lucky escape");
  for (const blank of ["", "   ", undefined, null, 7]){
    const quiet = ENGINE.endSkip(ENGINE.applySpin(game(), "skip"), blank);
    assert.equal("m" in quiet.history[0], false, `${JSON.stringify(blank)} should leave no field`);
  }
});

test("endSkip refuses to run on a turn that was not skipped", () => {
  assert.throws(() => ENGINE.endSkip(game()), /spin first/i);
  assert.throws(() => ENGINE.endSkip(ENGINE.applySpin(game(), "double")), /Nothing to skip/);
});

test("the wheel turns once per turn, and only on real outcomes", () => {
  const s = ENGINE.applySpin(game(), "skip");
  assert.throws(() => ENGINE.applySpin(s, "skip"), /already spun/);
  for (const junk of ["", "SKIP", "jackpot", null, 2]){
    assert.throws(() => ENGINE.applySpin(game(), junk), /isn't a spin outcome/);
  }
});

test("detonating on the first of two guesses ends it there", () => {
  let s = ENGINE.applySpin(game(), "double");
  s = ENGINE.applyGuess(s, 42);
  assert.equal(s.over, true);
  assert.equal(s.loser, 0);
  assert.deepEqual([s.spin, s.left], ["", 0], "the second guess is written off");
  assert.throws(() => ENGINE.applySpin(s, "normal"), /already over/);
  assert.throws(() => ENGINE.endSkip(s), /already over/);
});

test("the second guess of Double Trouble can be the fatal one", () => {
  let s = ENGINE.applySpin(game(), "double");
  s = ENGINE.applyGuess(s, 30);
  s = ENGINE.applyGuess(s, 42);
  assert.equal(s.over, true);
  assert.equal(s.loser, 0, "the same player wears it");
  assert.deepEqual(s.history.map(h => h.side), ["low", "boom"]);
});

test("the odds sum to 100 and every slice lands where it should", () => {
  assert.deepEqual(ENGINE.SPINS, ["normal", "double", "skip"]);
  assert.equal(ENGINE.SPINS.reduce((t, k) => t + ENGINE.SPIN_ODDS[k], 0), 100);
  const real = Math.random;
  try {
    const at = n => { Math.random = () => n / 100; return ENGINE.randomSpin(); };
    for (const n of [0, 1, 49]) assert.equal(at(n), "normal", `${n} is a normal turn`);
    for (const n of [50, 60, 74]) assert.equal(at(n), "double", `${n} is Double Trouble`);
    for (const n of [75, 90, 99]) assert.equal(at(n), "skip", `${n} is a skip`);
  } finally { Math.random = real; }
});

test("a thousand spins stay inside the three outcomes", () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(ENGINE.randomSpin());
  assert.deepEqual([...seen].sort(), ["double", "normal", "skip"]);
});

test("a tampered state cannot mint itself extra guesses", () => {
  const base = ENGINE.applySpin(game(), "double");
  assert.equal(ENGINE.isValidState(base), true);
  for (const bad of [
    { spin: "normal", left: 2 },
    { spin: "normal", left: 0 },
    { spin: "double", left: 3 },
    { spin: "double", left: 0 },
    { spin: "skip", left: 1 },
    { spin: "", left: 1 },
    { spin: "jackpot", left: 1 },
    { spin: "double", left: "2" }
  ]){
    assert.equal(ENGINE.isValidState({ ...base, ...bad }), false, JSON.stringify(bad));
    assert.equal(ENGINE.decodeState(ENGINE.encodeState({ ...base, ...bad })), null);
  }
});

test("a finished game carries no live spin", () => {
  let s = ENGINE.applyGuess(ENGINE.applySpin(game(), "normal"), 42);
  assert.equal(ENGINE.isValidState(s), true);
  assert.equal(ENGINE.isValidState({ ...s, spin: "double", left: 2 }), false);
});

test("a rematch clears the wheel", () => {
  let s = play(game(), 30);
  s = play(s, 42);                                   // Mei (1) loses
  const again = ENGINE.rematch(s, 60);
  assert.deepEqual([again.spin, again.left], ["", 0]);
  assert.equal(ENGINE.validateGuess(again, 50).ok, false, "everyone spins from scratch");
});

test("a half-spun turn survives a turn code round trip", () => {
  const mid = ENGINE.applyGuess(ENGINE.applySpin(game(), "double"), 30, "one down");
  const back = ENGINE.decodeState(ENGINE.encodeState(mid));
  assert.deepEqual([back.spin, back.left, back.turn], ["double", 1, 0]);
  assert.equal(ENGINE.validateGuess(back, 55).ok, true, "the second guess travels with it");
});

test("a skipped turn survives a room document round trip", () => {
  const s = ENGINE.endSkip(ENGINE.applySpin(game(), "skip"), "not today");
  const back = ENGINE.fromDoc(ENGINE.toDoc(s, { code: "AB12" }));
  assert.deepEqual(back.history, [{ p: 0, side: "skip", m: "not today" }]);
  assert.equal(back.turn, 1);
});

test("skips and doubles still drive the game to a forced detonation", () => {
  const real = Math.random;
  let seed = 7;
  try {
    // deterministic pseudo-random, so a failure here is reproducible
    Math.random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let run = 0; run < 40; run++){
      let s = game({ secret: 1 + 1 + Math.floor(Math.random() * 97) });
      let turns = 0;
      while (!s.over){
        assert.ok(++turns < 1000, "a game that never ends");
        s = ENGINE.applySpin(s, ENGINE.randomSpin());
        if (s.spin === "skip"){ s = ENGINE.endSkip(s); continue; }
        while (!s.over && s.left > 0){
          assert.ok(ENGINE.remaining(s) >= 1, "a legal guess always exists");
          s = ENGINE.applyGuess(s, s.lo + 1);
        }
      }
      assert.equal(s.history[s.history.length - 1].side, "boom");
      assert.ok(s.loser !== null);
    }
  } finally { Math.random = real; }
});

test("a room from before the spin is refused rather than half-loaded", () => {
  assert.equal(ENGINE.VERSION, 3);
  const doc = ENGINE.toDoc(play(game(), 30), { code: "AB12" });
  assert.equal(ENGINE.fromDoc(doc) === null, false, "a current room still loads");
  const stale = { ...doc, v: 2 };
  delete stale.spin; delete stale.left;
  assert.equal(ENGINE.fromDoc(stale), null, "a v2 room does not load");
  assert.equal(ENGINE.decodeState(ENGINE.encodeState({ ...play(game(), 30), v: 2 })), null,
    "and neither does a v2 turn code");
});

// --- the number the odds preview is built from ------------------------------
test("remaining() is hi minus lo minus one at the edge", () => {
  // The preview says "1 in N" and switches to "One number left" off this
  // count. Computing it from hi - lo instead would fire both a turn late.
  assert.equal(ENGINE.remaining({ lo: 30, hi: 32 }), 1, "30–32 leaves only 31");
  assert.equal(ENGINE.remaining({ lo: 30, hi: 31 }), 0, "adjacent bounds leave nothing");
});

// --- the reel ---------------------------------------------------------------
// The reel is cosmetic, but it is the only thing most players ever see of the
// draw. A reel that stops somewhere other than the drawn outcome misreports
// the game: it hides the real result for a beat, and makes whichever face it
// always stops on look far more common than it is.

test("the reel stops on the outcome that was actually drawn", () => {
  for (const outcome of ENGINE.SPINS){
    const faces = ENGINE.spinReel(outcome);
    assert.equal(faces[faces.length - 1], outcome, `reel for "${outcome}" must end on it`);
  }
});

test("the reel always opens on the same face, so it gives nothing away", () => {
  const firsts = ENGINE.SPINS.map(o => ENGINE.spinReel(o)[0]);
  assert.deepEqual(firsts, [ENGINE.SPINS[0], ENGINE.SPINS[0], ENGINE.SPINS[0]],
    "a reel that starts differently per outcome telegraphs the result");
});

test("the reel shows only real faces, in order, and passes each one", () => {
  for (const outcome of ENGINE.SPINS){
    const faces = ENGINE.spinReel(outcome);
    assert.ok(faces.every(f => ENGINE.SPINS.includes(f)), "no invented faces");
    assert.equal(new Set(faces).size, ENGINE.SPINS.length, "every face is shown");
    faces.forEach((f, i) => {
      assert.equal(f, ENGINE.SPINS[i % ENGINE.SPINS.length], "faces run in order");
    });
  }
});

test("the reel is long enough to read as a spin, and bounded", () => {
  for (const outcome of ENGINE.SPINS){
    const n = ENGINE.spinReel(outcome).length;
    assert.ok(n >= 2 * ENGINE.SPINS.length, `${outcome}: ${n} frames is not a spin`);
    assert.ok(n <= 24, `${outcome}: ${n} frames keeps the player waiting`);
  }
  // a shorter reel still has to land correctly
  for (const outcome of ENGINE.SPINS){
    const faces = ENGINE.spinReel(outcome, 1);
    assert.equal(faces[faces.length - 1], outcome);
  }
});

test("the reel refuses an outcome the wheel does not have", () => {
  for (const junk of ["", "SKIP", "jackpot", null, 2]){
    assert.throws(() => ENGINE.spinReel(junk), /isn't a spin outcome/);
  }
});

// --- the last number --------------------------------------------------------
// When one legal number is left it is the bomb, so there is nothing to choose
// and the page offers a button instead of a guess box. The risk in that feature
// is the ordering: fire it before the spin and a skip can no longer save
// anybody, which silently removes the best thing the wheel does.

const oneLeft = () => {
  // 40–42 leaves exactly 41, and 41 is the bomb.
  let s = game({ secret: 41 });
  s = play(s, 40);
  s = play(s, 42);
  return s;
};

test("one number left means that number is the bomb", () => {
  // The button is only safe because of this. Squeeze the range shut from both
  // sides for every bomb position in the range and check it holds each time.
  // (Walking up from the floor never gets here — it detonates on the way.)
  for (let secret = 2; secret <= 99; secret++){
    let s = game({ secret });
    if (secret - 1 > s.lo) s = play(s, secret - 1);
    if (secret + 1 < s.hi) s = play(s, secret + 1);
    assert.equal(s.over, false, `secret ${secret}: neither squeeze should be fatal`);
    assert.equal(ENGINE.remaining(s), 1, `secret ${secret}: one number should be left`);
    assert.equal(s.lo + 1, s.secret, `secret ${secret}: the last number must be the bomb`);
  }
});

test("the wheel still comes first with one number left", () => {
  const s = oneLeft();
  assert.equal(ENGINE.remaining(s), 1);
  assert.equal(s.spin, "", "a fresh turn has not spun yet");
  assert.equal(ENGINE.turnControl(s), "spin",
    "firing the last number before the spin would delete the skip reprieve");
});

test("a skip with one number left is a reprieve, not a detonation", () => {
  const s = ENGINE.applySpin(oneLeft(), "skip");
  assert.equal(ENGINE.turnControl(s), "skip");
  const next = ENGINE.endSkip(s);
  assert.equal(next.over, false, "nobody blew up");
  assert.deepEqual([next.lo, next.hi], [40, 42], "the number is still out there");
  assert.equal(next.turn, (s.turn + 1) % s.players.length,
    "and it is the next player's problem now");
  assert.equal(ENGINE.turnControl(next), "spin", "who also gets to spin first");
});

test("after a real spin, one number left is the wire", () => {
  for (const outcome of ["normal", "double"]){
    const s = ENGINE.applySpin(oneLeft(), outcome);
    assert.equal(ENGINE.turnControl(s), "wire", `${outcome} with one number left`);
    // and the button's number is a legal move that detonates
    const boom = ENGINE.applyGuess(s, s.lo + 1);
    assert.equal(boom.over, true);
    assert.equal(boom.loser, s.turn);
    assert.equal(boom.history[boom.history.length - 1].side, "boom");
  }
});

test("more than one number left is still a guess", () => {
  const s = ENGINE.applySpin(game(), "normal");
  assert.ok(ENGINE.remaining(s) > 1);
  assert.equal(ENGINE.turnControl(s), "guess");
});

test("Double Trouble can narrow the range onto its own wire", () => {
  let s = ENGINE.applySpin(game({ secret: 41 }), "double");
  s = ENGINE.applyGuess(s, 40);
  assert.equal(ENGINE.turnControl(s), "guess", "two numbers left, still a guess");
  s = ENGINE.applyGuess(s, 42);
  // the second guess of the pair closed the range onto the bomb — but the pair
  // is spent, so the turn moved on and the next player spins for it
  assert.equal(ENGINE.remaining(s), 1);
  assert.equal(s.turn, 1);
  assert.equal(ENGINE.turnControl(s), "spin");
});

test("a finished game is waiting on nothing", () => {
  const s = ENGINE.applyGuess(ENGINE.applySpin(oneLeft(), "normal"), 41);
  assert.equal(s.over, true);
  assert.equal(ENGINE.turnControl(s), "none");
  assert.equal(ENGINE.turnControl(null), "none");
});
