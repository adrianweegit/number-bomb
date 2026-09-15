# 💣 Number Bomb

A turn-based party game for a group chat. Someone hides a number inside a
range; everyone else takes turns guessing. Every wrong guess narrows the range,
so the trap closes with each turn. Whoever guesses the hidden number sets it
off — and pays the forfeit.

One page, no build step, no framework, no dependencies at runtime.

```
FLOOR                                    CEILING
  38                                        71
  ══════════[ live wire ]══════════
  32 numbers still live        66 cut away
```

---

## Play it

### Synced rooms — everyone on their own phone

The host opens a room and gets a four-character code. Everyone joins with that
code from their own phone, anywhere in the world. One shared game: the range,
the turn order and the bomb live in one place, and every phone updates the
moment someone plays.

- **Whoever types the number referees and does not get a turn** — they know
  where the bomb is. Tap **Random** instead and nobody knows it, host included,
  so everyone at the table plays.
- **Invite by link.** The lobby's Invite button shares a message carrying the
  room code, the forfeit and a `?r=CODE` link. Opening that link fills the code
  in for the arriving player; if the game has already started they get a
  read-only **Watching** view instead.
- Only the player whose turn it is gets a guess box.
- **Trash talk with your guess.** One optional line, capped at 80 characters,
  shown under your name in the cut log. The box asks for it differently every
  turn.
- When it becomes your turn the page prompts you — a buzz, a chime, and a
  browser notification if you allowed one.
- **Install it to your Home Screen** and it opens like an app, badges its icon
  when you are up, and works offline for pass-the-phone. On iPhone this is also
  what lets Safari show turn alerts at all.
- The tab title says whose turn it is, so a glance answers it without opening
  anything: *● Your turn* or *Waiting for Mei*.
- Come back after a while and it tells you what you missed — how many guesses
  went by and where the range closed to.
- **No clock.** Take an hour or a week between turns. Close the page and come
  back; your seat is still yours and the game is where you left it.
- The host can deal a rematch and every phone follows.

Rooms need a backend. Set one up once — **[FIREBASE-SETUP.md](FIREBASE-SETUP.md)**,
about fifteen minutes, free tier — and the link works for anyone. No account,
no sign-in, no app install: players are signed in anonymously behind the scenes
so the rules can tell whose turn it is.

### Pass the phone — works anywhere, with no setup at all

One device goes round the table. No network, no accounts. Open `index.html` off
your desktop and it plays.

Not in the same room? Switch to **send a turn code**: after your guess you get a
pre-written message for the group chat, and the next player picks up from it.
The handoff is a tappable link when the page is served from a real address, and
a pasteable code when it can't hand out its own address — an embedded viewer, or
a file opened off disk.

---

## Quick start

```bash
git clone https://github.com/adrianweegit/number-bomb.git
cd number-bomb
npm run serve        # http://localhost:8080 — pass-the-phone works immediately
```

To turn on synced rooms, follow [FIREBASE-SETUP.md](FIREBASE-SETUP.md), then
either:

| Host on | Command | You get |
|---|---|---|
| **GitHub Pages** | Settings → Pages → deploy from `main` / root | `https://<user>.github.io/number-bomb/` |
| **Firebase Hosting** | `npm run deploy` | `https://<project>.web.app` |

Both are free. Firebase Hosting ships the security rules in the same command;
with Pages, run `npm run deploy:rules` separately whenever the rules change.

The page tells you which backend it found, in the badge top-left:

| Badge | Meaning |
|---|---|
| **Open room** | Your Firebase project is live. Anyone with the link can play. |
| **Ready** | No backend configured. Pass the phone still works. |

---

## The rules, precisely

- The range starts at 1–100 and shrinks. The **floor** and **ceiling** are the
  current bounds.
- A guess must be **strictly inside** the live range. If the range is 30–55, the
  legal guesses are 31 through 54. Guessing a bound is refused and **does not
  cost you your turn** — you just guess again.
- Guess **below** the bomb → your number becomes the new floor.
- Guess **above** the bomb → your number becomes the new ceiling.
- Guess the bomb exactly → **BOOM**. Game over, and it's on you.

Excluding the bounds is what makes the game terminate. Because the bomb always
sits strictly between the floor and the ceiling, there is always at least one
legal guess left, and the range loses at least one number every turn. When the
range narrows to something like 41–43, exactly one legal guess remains — and it
is the bomb. Somebody has to cut that wire.

For the same reason the bomb can't be armed on a boundary: a bomb at 1 in a
1–100 range would leave the range stuck with nothing legal to guess. Setup
refuses it and says why.

---

## Tests

```bash
npm install
npm test              # engine + security rules
npm run test:engine   # rules of the game — no network, no dependencies
npm run test:rules    # security rules, against the Firestore emulator (needs Java)
```

**34 engine tests.** The important one walks every game to completion using the
slowest legal strategy and asserts it always detonates — never a deadlock,
never a state with no legal move. The rest cover the trust boundary: a turn code
or room document is data from someone else's phone, so a tampered or truncated
one is discarded outright rather than half-loaded into an unplayable game.

**25 security-rule tests.** These guard a database anyone with the link can
reach, so they run on every push. Verified refused, for a client writing
straight to Firestore with the page's own credentials and no interface in the
way: moving out of turn, guessing outside or on the bounds, shifting the wrong
bound, skipping a player, rewriting or truncating the log, re-arming the bomb,
editing the roster, changing the forfeit, blaming someone else for a
detonation, playing on after it, starting or dealing a rematch without being
host, deleting someone else's room, taking someone else's seat.

One of them plays a 120-move game on purpose. Firestore caps rule evaluation at
1000 expressions per request and re-evaluates a rules function at every call
site, so a rule that passes short tests can quietly start refusing *honest*
moves deep into a long game. The rules bind their values once with `let` to stay
inside that budget, and the long-game test is what keeps it that way.

---

## What this does not protect against

**A determined player can read the bomb.** It is never stored as a plain number
— each room salts and scrambles it — but every client needs the value to judge
its own guess, and security rules can validate a write without being able to
compute one. Adjudicating a guess server-side would need a Cloud Function, which
means Firebase's Blaze plan.

This is a game about who eats the last spring roll. If your group has that one
person, play pass-the-phone on one device, where there is nothing to inspect.

**Nothing can reach you once the browser is fully closed.** This is a static
site with no server of its own, and a web page cannot send a notification when
it is not running. Installing to the Home Screen and allowing notifications
covers the case where the game is open in the background; past that, the page
can only make checking cheap — an app icon that badges, a tab title that says
whose turn it is, and a summary of what you missed.

Reaching a closed phone needs something running elsewhere, and there are only
two honest routes: web push through a small always-on endpoint holding the send
key, or WhatsApp's Business Cloud API. Worth knowing before anyone plans
around it: **no official API can post into a WhatsApp group.** The Cloud API is
strictly one-to-one, so nudges there would arrive as direct messages from a
business number, cost per message, and need each player's phone number. Posting
into the group itself is only possible by driving a logged-in personal account
with an unofficial library, against WhatsApp's terms and at the risk of that
number being banned.

**A player who wanders off stalls the game.** There is no turn timer and no way
to skip someone — deliberately, since the whole point is that it waits. The
nudge button sends them a WhatsApp message by hand; beyond that, the host starts
a fresh room.

---

## How it fits together

| File | What it is |
|---|---|
| `index.html` | The whole game — markup, styles, rules engine, both backends. |
| `engine.test.mjs` | Pulls the marked engine block out of the page and tests it. |
| `firestore.rules` | The security boundary for synced rooms. |
| `firestore.rules.test.mjs` | Those rules, against the emulator. |
| `config.example.js` | Copy to `config.js` with your Firebase project's values. |
| `manifest.webmanifest` | Makes it installable to a Home Screen. |
| `sw.js` | Service worker. Network-first, so it never serves a stale game. |
| `FIREBASE-SETUP.md` | The fifteen minutes of console work, step by step. |

The rules of the game live in one marked block inside `index.html` so the page
stays a single shareable file, and the test suite extracts that block rather
than duplicating it.

## Handing this to a reviewer

[HANDOFF.md](HANDOFF.md) is a complete technical brief — architecture, data
model, security rules, deployment, tests, decisions already made and why, and a
template for proposing enhancements. Written for someone who has never seen the
code.

## License

MIT — see [LICENSE](LICENSE).
