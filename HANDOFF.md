# Number Bomb — build handoff

**Purpose of this document.** It is a complete technical brief for a reviewer
(Claude, ChatGPT, or a person) who has not seen the codebase. Read it, then
propose enhancements using the template in [§16](#16-how-to-propose-an-enhancement).
Proposals come back to the implementing agent, who ships them.

**Reviewers: you are writing specifications, not code.** The value you add is a
precise, buildable proposal that respects the constraints in
[§15](#15-constraints-any-proposal-must-respect) and does not re-tread the
decisions in [§13](#13-decisions-already-made-do-not-re-propose-without-new-information).

Last updated against commit `6116650`. Verify with `git log --oneline -1`.

---

## 1. What the thing is

A turn-based party game for a group of friends. One person hides a number in a
range; the others take turns guessing. Every wrong guess narrows the range.
Whoever guesses the hidden number "detonates" it and pays a forfeit the group
agreed up front ("eats the last piece on the dish").

Audience: a WhatsApp friend group, on phones, in different places, playing over
hours or days. Not a competitive game; the stakes are comic.

### The rule that makes it work

A guess must be **strictly inside** the live range. If the range is 30–55, legal
guesses are 31–54. Guessing a bound is refused and does **not** cost your turn.

- guess < bomb → the guess becomes the new floor
- guess > bomb → the guess becomes the new ceiling
- guess == bomb → detonation, game over

When the range is down to one number, that number is the bomb, so the page
stops asking for a guess it already knows and offers a single button instead
(`Cut the wire — 43`). `turnControl()` decides that, and it is a tested engine
function rather than a condition in the page for one reason: **the spin comes
first**. A skip drawn with one number left is a real reprieve — the bomb moves
to the next player — and firing the last number before the spin would silently
delete it. The player still presses the button; the forfeit sticks better when
somebody did it than when the game did it to them.

The reel that shows the spin is cosmetic, but `spinReel()` owns the order of
faces it walks and where it stops, so that a test can prove it stops on the
outcome that was drawn. It shipped once not doing that — a fixed twelve frames
over three faces stops on face three every time — which hid the real result for
a beat and made Skip look roughly twice as common as its 25%.

Since v3 every turn opens with a **lucky spin**, drawn on the phone that is up:
`normal` (50%) buys one guess, `double` (25%) buys two taken back to back with
no second spin, `skip` (25%) buys none and hands the turn straight on. A skip is
written to the log as `{ p, side: "skip" }` with no `g`. None of this touches the
invariant below — the range only ever moves on a guess, and the bomb still sits
strictly inside it — but a turn can now produce zero guesses or two.

This exclusivity is load-bearing. Because the bomb always sits strictly between
floor and ceiling, a legal guess always exists **and** the range loses at least
one number per turn, so the game cannot deadlock and must terminate. A bomb
armed on a boundary would break the invariant, so setup refuses it.

`engine.test.mjs` proves this by walking every game to completion using the
slowest legal strategy.

---

## 2. Live addresses

| Thing | Where | Notes |
|---|---|---|
| Repo | `github.com/adrianweegit/number-bomb` | Public. Must stay public for free Pages. |
| Live game | `https://adrianweegit.github.io/number-bomb/` | GitHub Pages, auto-deploys on push to `main`. |
| Firebase project | `number-bomb-a166b` | Spark (free) plan. |
| CI | GitHub Actions, `.github/workflows/test.yml` | Runs both suites on push and PR. |
| Artifact copy | a private `claude.ai/artifact/...` page | **Stale** and workspace-only. See §14. |

---

## 3. Repository layout

```
index.html                 the entire game — markup, styles, rules engine, both
                           backends. 2,099 lines, ~92 KB. No build step.
engine.test.mjs            34 tests. Extracts the engine block from index.html.
firestore.rules            security rules. The real boundary for synced play.
firestore.rules.test.mjs   25 tests, run against the Firestore emulator.
config.js                  this project's Firebase web config. Committed on
                           purpose — see §7.
config.example.js          the template a forker copies.
firebase.json              hosting config, rules path, emulator ports.
firestore.indexes.json     empty; no composite indexes are needed.
.firebaserc.example        project alias template (.firebaserc is gitignored).
manifest.webmanifest       makes it installable to a home screen.
sw.js                      service worker. Network-first by design.
icon-180/192/512.png       app icons.
package.json               test and deploy scripts. Dev dependencies only.
.github/workflows/test.yml CI.
README.md                  player- and contributor-facing overview.
FIREBASE-SETUP.md          the console steps to stand up a fresh project.
```

There are **no runtime dependencies**. The only third-party code the page loads
is the Firebase compat SDK from `gstatic.com`, and only when a backend is
configured.

---

## 4. Architecture

One HTML file, three interchangeable transports behind one document-shaped API.

```
        ┌──────────────────────────────────────────┐
        │  ENGINE  (pure, no DOM, no network)      │
        │  rules · validation · codecs             │
        └───────────────┬──────────────────────────┘
                        │  same state shape
        ┌───────────────┴──────────────────────────┐
        │  APP LAYER  (DOM, screens, rendering)    │
        └───┬───────────────┬──────────────────┬───┘
            │               │                  │
      ┌─────┴─────┐   ┌─────┴──────┐   ┌───────┴────────┐
      │ firebase  │   │  artifact  │   │  local / relay │
      │ Firestore │   │ Claude db  │   │ no backend     │
      │ anyone    │   │ workspace  │   │ pass the phone │
      └───────────┘   └────────────┘   └────────────────┘
```

**Why this shape.** The Claude artifact store exposes a Firestore-shaped API
(`doc()`, `collection()`, `onSnapshot()`, `get/set/update/delete`). The Firebase
transport is therefore a thin adapter (`wrapFirestore()` in `index.html`) onto
the same calls, and everything above it was written once.

**Backend selection** happens at boot, in this order:

1. `window.NUMBER_BOMB_FIREBASE` present and `projectId` not a `YOUR_` placeholder
   → connect Firebase, sign in anonymously. Badge reads **Open room**.
2. Otherwise `claude.use("db")` → the artifact store. Badge reads **Synced**.
3. Otherwise no backend. Badge reads **Ready**; Start and Join are disabled and
   pass-the-phone still works.

The page renders and plays before any backend answers. Nothing blocks on it.

### Screens

`Home · Host · Join · Lobby · Local · Play · Relay · Over`

`Play` and `Over` are shared by all transports. `Lobby`, `Host` and `Join` are
online-only. `Local` and `Relay` are the no-backend path.

---

## 5. The engine

Lives inside `index.html` between the markers:

```js
// ===== ENGINE START =====
// ===== ENGINE END =====
```

**These markers are load-bearing.** `engine.test.mjs` slices the file on them and
evaluates the block. Renaming or removing them breaks the test suite.

### Exports

```
VERSION (3)  MAX_PLAYERS (10)  MAX_MESSAGE (80)  MODES  PENALTIES  CODE_ALPHABET
SPINS  SPIN_ODDS  SPIN_GUESSES
remaining()      createGame()   validateGuess()  applyGuess()  rematch()
randomSecret()   newRoomCode()  encodeState()    decodeState() isValidState()
toDoc()          fromDoc()      hideNumber()     showNumber()
randomSpin()     spinReel()     applySpin()    endSkip()   turnControl()
```

### Playable state shape

```js
{
  v: 3,
  players: ["Adrian", "Umbrella"],   // display names, index = turn order
  lo0: 1, hi0: 100,                  // the range as opened; immutable
  lo: 38, hi: 71,                    // the live range
  secret: 42,                        // in memory only, never written raw
  penalty: "eats the last piece on the dish",
  mode: "pass" | "relay" | "online",
  turn: 0,                           // index into players
  spin: "" | "normal" | "double" | "skip",  // this turn's wheel; "" = not spun
  left: 0,                           // guesses this turn still owes
  history: [ { p, g?, side, m? } ],  // append-only
  over: false,
  loser: null                        // index into players once over
}
```

A history entry: `p` player index, `g` the guess (absent on a skip), `side` one
of `"low" | "high" | "boom" | "skip"`, `m` an optional message (≤ 80 chars,
absent when empty).

`spin` and `left` must agree, and `isValidState()` enforces it: `""` and
`"skip"` owe 0, `"normal"` owes 1, `"double"` owes 2 then 1. A finished game
carries `spin: ""`, `left: 0`. Guessing is refused until `left > 0`, which is
what stops a tampered state minting extra guesses.

Online rooms carry extra fields alongside: `code`, `hostId`, `phase`, `seats`.
`isValidState()` ignores unknown fields, so transports can add their own.

### Codecs

- `hideNumber(n)` / `showNumber(s)` — the bomb, salted per room and scrambled,
  so it is never a plain number in storage. **Obfuscation, not encryption.**
- `encodeState()` / `decodeState()` — a whole game as a pasteable turn code,
  used by the no-backend relay mode.
- `toDoc()` / `fromDoc()` — playable state ↔ Firestore document.

Everything arriving from outside goes through `isValidState()`, which checks
every field and the `lo < secret < hi` invariant, and returns `null` rather than
half-loading a broken game.

---

## 6. Firestore data model

```
rooms/{CODE}                     the game
rooms/{CODE}/seats/{uid}         one document per player, written only by them
```

`{CODE}` is four characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — 32
characters with `I`, `O`, `0` and `1` removed because people misread them.
1,048,576 possible codes. `mintCode()` checks for a free one, retrying up to six
times.

### Room document

```js
{
  v: 3,
  code: "4F2K",
  phase: "lobby" | "playing",
  hostId: "<uid of whoever opened it>",
  mode: "online",
  lo0, hi0,                  // the range as opened
  lo, hi,                    // the live range
  bomb: "<scrambled string>",
  penalty: "<≤120 chars>",
  players: ["Adrian", ...],  // frozen at start, parallel to seats
  seats: ["<uid>", ...],     // frozen at start; index = turn order
  turn, spin, left, history, over, loser,
  createdAt, updatedAt
}
```

`players[i]` is the display name of `seats[i]`. The pairing is what maps a turn
to a device.

### Seat document

```js
{ name: "<1–18 chars>", joinedAt: <epoch ms> }
```

Seats are a subcollection rather than an array specifically so **joining cannot
race** — each player writes only their own document.

### Lifecycle

1. Host writes the room in `phase: "lobby"` with empty `players`/`seats`.
2. Host writes their own seat **only if the bomb was armed at random** (§13).
3. Players join by writing their seat.
4. Host starts: freezes `seats` and `players` from the seat list, sets
   `phase: "playing"`.
5. Each turn opens with a **spin**: one `update()` of `spin`, `left` and
   `updatedAt` by the player whose turn it is, touching nothing else.
6. Then, depending on the wheel:
   - **skip** — one `update()` of `turn`, `history` (a `side: "skip"` entry),
     `spin: ""`, `left: 0`. The range does not move.
   - **normal / double** — one `update()` per guess: `lo/hi`, `turn`, `history`,
     `spin`, `left`, `over`, `loser`, `updatedAt`. On the first of a double the
     turn does **not** advance and `left` drops to 1; the second releases it.
7. Detonation sets `over: true` and `loser`, and clears `spin`/`left` — a second
   guess owed by Double Trouble is written off.
8. Host may rematch: new `bomb`, empty `history`, same `seats`/`players`, wheel
   at rest.

Each client holds **two** listeners: the room document and the seats collection.

### Version

`ENGINE.VERSION` is **3**. The lucky spin added `spin` and `left` to the room
document and a fourth `side` to the log, so v2 and v3 are not interchangeable:

- `isValidState()` refuses any state whose `v` is not 3, so a v2 room document
  or turn code is discarded rather than half-loaded. The page says the room
  "didn't read cleanly".
- The rules refuse to open, start, spin in, move in or rematch a v2 room at all,
  so an old room cannot be driven by an old cached page either.

**A room or share link created before v3 shipped is dead and has to be started
again.** That was a deliberate choice over letting a stale cached page
misinterpret a game it does not understand.

---

## 7. Auth and identity

**Firebase Anonymous Authentication**, and nothing else. No email, no password,
no profile, no PII. Opening the link is the entire onboarding.

The anonymous `uid` **is** the seat id: it is what the rules check to decide
whose turn it is, and what lets someone close the page and come back to their
seat. It is per-browser; clearing site data loses the seat.

In the no-backend path a random id in `localStorage` plays the same role.

`config.js` is **committed deliberately**. A Firebase web config is a public
identifier that ships to every browser that loads the page — it is not a
credential. GitHub Pages serves only what is committed, so rooms would not work
otherwise. The security boundary is `firestore.rules`, which is why those rules
are tested. An HTTP-referrer restriction on the browser key in the Google Cloud
console is available if desired.

---

## 8. Security rules

`firestore.rules`. This database is reachable by anyone who opens the link, so
these rules are the only thing standing between the game and the internet.

### Verified refused

Tested against a client writing **directly to Firestore with the page's own
credentials**, bypassing the interface entirely:

- moving out of turn
- guessing outside the live range, or exactly on a bound
- moving the wrong bound, or moving it somewhere other than the guess
- skipping a player, or keeping the turn
- rewriting or truncating earlier moves in the log
- re-arming the bomb, editing the roster, changing the forfeit
- blaming someone else for a detonation
- playing on after detonation
- starting or dealing a rematch without being the host
- deleting someone else's room, taking someone else's seat
- a message over 80 characters, empty, or not a string
- spinning out of turn, spinning twice in a turn, or spinning after detonation
- claiming more guesses than the outcome allows (`normal` with 2, `double` with 3…)
- moving the range, the log or the turn while pretending to spin
- guessing with no spin on the wheel, or on a spin that said skip
- claiming a skip without a skip on the wheel, or smuggling a number into one
- stretching Double Trouble into a third guess, or leaving after only one
- moving or spinning in a v2 room left running across the republish

### What they cannot do

**They cannot hide the bomb.** Every client needs the value to judge its own
guess, and rules can *validate* a write but never *compute* one. Server-side
adjudication needs a Cloud Function, which needs the Blaze plan. The bomb is
therefore stored scrambled and salted per room, which defeats a casual look at
the database but not a determined player reading the page source.

**They cannot draw the spin.** Same limitation. The outcome is drawn on the
phone that is up and declared to the room; the rules check that the turn which
follows is consistent with the declaration, never the draw itself. A modified
client could spin Skip every turn.

### ⚠️ The expression budget — read before editing

Firestore caps rule evaluation at **1000 expressions per request**, and a rules
*function* is re-evaluated at every call site.

An earlier draft of these rules passed every short test while silently
exhausting that budget. Writes were then denied for **exhaustion rather than on
merit** — invisible in small tests, and it would have started refusing *honest*
moves deep into a long game.

The rules now bind their values once with `let` and compare fields inline.
`firestore.rules.test.mjs` plays a **120-move game** to prove an honest move
still evaluates at depth while a dishonest one is still refused on merit. Any
rewrite that reintroduces helper-function-per-field style will pass the short
tests and reintroduce the bug.

The lucky spin hit this again, and it is worth knowing how. `isSpin()` was first
written the obvious way — naming every field that must hold still, fourteen
equality checks. Adding that fourth function pushed **every refused write in the
suite**, even on an empty log, past the cap: the tests still passed, because
`assertFails` does not care *why* a write was refused. It was caught only by
counting the emulator's `maximum of 1000 expressions` warnings and comparing
against `main`, which emits none.

The fix was one expression instead of fourteen:

```
n.diff(p).affectedKeys().hasOnly(['spin', 'left', 'updatedAt'])
```

which is also *stricter* than the enumeration it replaced. **If you add a rule
function, grep the emulator output for that warning — a green suite does not
mean you stayed inside the budget.**

### ⚠️ Rules do not ship with the page

They live in Firebase. Pushing to GitHub does **not** update them. After any
change to `firestore.rules`, someone must run `npm run deploy:rules` or paste
the file into the Firestore console Rules tab and Publish. **Any proposal that
touches rules must say so explicitly.**

---

## 9. Hosting and deployment

**Page** — GitHub Pages, deploy from branch `main`, folder `/` (root). Every
push to `main` redeploys automatically. `.nojekyll` is present. Nothing to run.

**Rules** — `npm run deploy:rules` (needs `npx firebase login` and
`npx firebase use --add` once). Or paste into the console.

**Alternative** — `npm run deploy` publishes page *and* rules to Firebase
Hosting at `number-bomb-a166b.web.app`. Currently unused; Pages is the live host.

The service worker is **network-first on purpose**: the site is updated by
pushing to `main`, so a cache-first worker would serve a stale game for days.
The cache exists only so pass-the-phone survives with no signal. Cross-origin
requests pass straight through so Firestore's realtime traffic is never
intercepted.

---

## 10. Tests and CI

```bash
npm install
npm test               # both suites
npm run test:engine    # 53 tests, no network, no deps
npm run test:rules     # 41 tests, needs Java for the Firestore emulator
```

CI runs both on every push and pull request: Ubuntu, Node 22, Temurin JDK 21.

**53 engine tests** cover the rules of the game and the trust boundary — a turn
code or room document is data from someone else's phone, so tampered,
truncated, deadlocking, NaN-producing and markup-bearing inputs are all
asserted to be rejected outright rather than half-loaded. Since the lucky spin
they also cover the wheel: the odds, the guess accounting, and a run of games
played to detonation with random spins to prove skips and doubles cannot
deadlock it.

**41 rules tests** cover the list in §8, plus the expression-budget test and an
integration test that plays a whole game through the emulator driving the
engine extracted from `index.html` — the guard against the rules and the engine
drifting apart.

Neither suite touches the real Firebase project. The rules suite runs entirely
against a local emulator with project id `demo-number-bomb`.

There is **no browser/E2E suite in CI**. Interactive behaviour has been verified
manually with Playwright against the emulators during development (multi-device
sync, turn gating, detonation, rematch, install, message rendering), but none of
that is automated. See §14.

---

## 11. PWA and turn prompts

- `manifest.webmanifest` + iOS meta tags make it installable to a home screen.
- `navigator.setAppBadge()` badges the icon when it is your turn.
- The tab title carries state: `● Your turn — Number Bomb` / `Waiting for Mei —`.
- Returning to a backgrounded tab forces a re-render and re-prompts, because
  mobile browsers suspend background tabs and the live listener may have slept.
- Coming back after a while shows what was missed, counting only other players'
  moves.
- On your turn: vibration, a two-tone chime, a title flash, and a browser
  notification if permission was granted.

**Nothing can reach a fully closed browser.** A page that is not running cannot
notify anyone. That is a platform fact, not a gap — see §13.

---

## 12. Design system

Direction: **"Nervous Bomb."** The bomb is a character and **his face is the
danger gauge** — a joke that carries information rather than decorating.

| Range cut away | Expression |
|---|---|
| < 25% | calm |
| 25–55% | nervous, sweating |
| 55–85% | worried, eyebrows |
| > 85% | panic, wide eyes, shaking |
| detonated | dead, X eyes |

Driven by `setMood()` from the same number the fuse draws.

**Type** — Bungee (display), Nunito (body), Space Mono (data and labels), from
Google Fonts with real fallback stacks.

**Colour** — tokens defined light-first on bare `:root`, redefined for
`prefers-color-scheme: dark` (guarded `:root:not([data-theme="light"])`) and for
`:root[data-theme="dark"]`.

```
--ground  #E9F0DF pistachio     --accent #FF4D3D coral
--panel   #FBFDF7               --grape  #5B3C9E
--panel-2 #DCE8CE               --lemon  #FFC93C
--ink     #241C2E grape-black   --safe   #2E9E6B
```

Sticker outlines (3px), hard offset shadows, one deliberately tilted label.
`prefers-reduced-motion` is respected throughout.

**Copy rule:** jokes go in the secondary line; the functional label stays plain.
`Safe floor` / `Safe ceiling` are labels; *"32 won't kill you"* is the aside.

---

## 13. Decisions already made — do not re-propose without new information

| Decision | Why |
|---|---|
| **No WhatsApp group bot** | No official API can post into a WhatsApp group. Meta's Business Cloud API is strictly one-to-one. Reaching the group needs an unofficial library driving a logged-in personal account, against WhatsApp's terms, risking a ban on a real person's number. |
| **No WhatsApp DM nudges** | Technically possible via the Cloud API, but: not the group, paid per template message, needs a dedicated number, template approval, and every player's phone number. Rejected as more friction for a worse notification. |
| **Web push: viable, declined for now** | Free, a real lock-screen notification, and the Firebase project already covers most of it. Needs one always-on endpoint (Cloudflare Workers free tier, or Blaze-plan Cloud Functions) to hold the send key. The owner chose in-page improvements instead. **This is the most likely next step if turn latency becomes the complaint.** |
| **Music: composed, parked** | A reactive Web Audio score exists as a design (tempo and layers follow the danger level, ~70→130 BPM, detonation sting). Not implemented. Owner's stated preference if revisited: **on from the moment a game starts**, never on the home screen, one-tap mute, remembered per device. |
| **Artifact-hosted backend abandoned** | Declaring the Claude artifact `db` capability makes the page organization-internal — only people signed into the same workspace can open it. Useless for outside friends. Firebase replaced it; the artifact path remains as a fallback. |
| **Bomb secrecy is honour-based** | Impossible to adjudicate server-side with rules alone (§8). Fixing it properly requires Cloud Functions and the Blaze plan (a card on file, though usage sits inside its free allowance). |
| **The bomb-setter referees** | If you type the number you know where it is, so you do not get a seat. Tapping **Random** arms it unknown to everyone, host included, and the host plays. A refereed game therefore needs two *other* players. |
| **`config.js` is committed** | See §7. It is a public identifier, not a credential. |
| **Pass-the-phone stays first-class** | It needs no sign-in, works offline and works for anyone. It is the fallback whenever no backend is configured, and must never be broken by a change to the online path. |

---

## 14. Known limitations and open items

**Limitations, accepted:**

- A determined player can read the bomb from the page source. Party-game threat
  model.
- No turn timer and no way to skip a player — deliberate; the game waits. A
  player who wanders off stalls it. The nudge button sends a WhatsApp message by
  hand.
- Rooms are never deleted. Codes and documents accumulate. Only the host may
  delete a room and the UI does not expose it; cleanup is via the console.
- Anonymous uid is per-browser. Clearing site data loses your seat.
- `setAppBadge` support is patchy on iOS; the title and away-summary work
  everywhere.
- On the loser's own phone the headline says *"You popped it"* while the penalty
  line says *"Umbrella eats the last piece"*. Making both "You" would produce
  *"You eats…"*, since forfeits are written third-person and player-authored.

**Open items:**

- **No automated browser tests.** Multi-device behaviour is the highest-risk,
  least-covered area. A Playwright suite against the emulators in CI would be
  the single biggest robustness win.
- **The artifact copy is stale.** A private Claude artifact page carries an
  older build and the workspace-only backend. Either refresh it or retire it.
- **No room cleanup** of any kind.
- **Music not implemented.**
- **No analytics.** Nobody knows how many games are played or where people drop
  out.

---

## 15. Constraints any proposal must respect

1. **No build step.** `index.html` is self-contained and served as-is. No
   bundler, no transpiler, no framework.
2. **No runtime dependencies** beyond the Firebase compat SDK, and that loads
   only when a backend is configured.
3. **It must still work with no backend.** Pass-the-phone and turn codes are the
   fallback and must survive every change.
4. **Keep the engine markers.** `// ===== ENGINE START/END =====` are how the
   tests find the code.
5. **Rules changes require a manual republish.** Say so in the proposal.
6. **Respect the 1000-expression budget** in rules; bind with `let` (§8).
7. **Bound every piece of user text.** A Firestore document is capped at 1 MiB
   and is downloaded by the whole room on every turn.
8. **Player-authored text renders with `textContent`, never `innerHTML`.**
9. **Spark (free) plan.** Anything needing Cloud Functions or Blaze must say so
   and justify it.
10. **Anonymous auth only.** Do not introduce accounts or collect PII, including
    phone numbers, without flagging it as a significant product change.
11. **Both themes, reduced motion, and 400px phone width** are all supported and
    must stay that way.
12. **Bumping `VERSION`** invalidates every live room and outstanding turn code.
    If a change alters the document shape, say what happens to games in flight.
13. **Tests are not optional.** Engine changes need engine tests; rules changes
    need rules tests.

---

## 16. How to propose an enhancement

Produce one block per enhancement, in this shape. Be specific enough that an
implementer does not have to guess; if you find yourself writing "somehow" or
"appropriately", the proposal is not finished.

```markdown
### <Short imperative title>

**Problem.** What is wrong today, for whom, observed how. Not a feature wish —
a problem statement.

**Proposal.** What changes from the player's side. Include the actual copy for
any new UI text.

**Why this over the alternatives.** What else you considered and why this wins.

**Files touched.** e.g. index.html (engine + app layer), firestore.rules,
engine.test.mjs

**Data model.** New or changed fields, with types and bounds. State what happens
to rooms already in flight when this ships.

**Security rules.** Exact change, or "none". If any: confirm it stays inside the
expression budget, and note that a manual republish is required.

**Tests to add.** Name them. What would fail if the change were wrong?

**Risks and rollback.** What could break, how it degrades, how to undo it.

**Cost.** Free / needs Blaze / needs a third-party service. Any change to reads
or writes per turn.

**Effort.** Small (under an hour) / Medium (a few hours) / Large.

**Constraint check.** Confirm against §15, calling out any constraint this
bends and why it is justified.
```

### Where the value probably is

Not a mandate, but these are the honest gaps, roughly in order:

1. **Automated browser tests in CI** — the biggest robustness gap (§14).
2. **Web push for turn notifications** — the biggest player-experience gap (§13).
3. **Room lifecycle** — cleanup, expiry, or a host "close room" control.
4. **Rejoining and roster edits** — no way to add a latecomer or drop someone
   who has left; the roster freezes at start by design, and the rules enforce it.
5. **Accessibility audit** — the game has never been tested with a screen reader.
6. **The referee could play after a rematch** — the rematch bomb is random, so
   they could fairly join, but the rules freeze the roster. Worth reconsidering.
7. **Music** (§13).

### What a good proposal looks like

Small, verifiable, and honest about cost. A proposal that says "add real-time
presence, a chat panel, emoji reactions and a leaderboard" is not one
proposal — it is four, and it will be sent back. One block each.
