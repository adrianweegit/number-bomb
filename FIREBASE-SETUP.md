# Hosting Number Bomb so anyone can join

The goal: one public web address you drop into a WhatsApp group, which any
friend can open — no account, no sign-in, no workspace, no app install — and
play a synced game with people in other cities.

This is the Firebase route. It costs nothing on Firebase's free Spark plan for
a game played among friends, and you own the project.

**You have to do these steps yourself.** They need your Google account, and I
have no way to create a project on your behalf. Everything on the code side is
already done and tested — what follows is roughly fifteen minutes of clicking
and two terminal commands.

---

## What you are setting up

| Piece | What it does | Cost |
|---|---|---|
| **Firestore** | Holds the live game. One document per room. | Free tier |
| **Anonymous Auth** | Gives each player an invisible identity so the rules can tell whose turn it is. No email, no password, nothing to sign up for. | Free |
| **Hosting** | Serves the page at a public HTTPS address. GitHub Pages or Firebase Hosting — your choice, step 6. | Free either way |

Free-tier ceilings are 50,000 document reads and 20,000 writes a day. A
three-player game costs a few hundred reads end to end, so you would need to be
running this at a scale well past a friend group to notice.

---

## 1. Create the project

1. Go to <https://console.firebase.google.com> and **Add project**.
2. Name it whatever you like — `number-bomb` is fine. Note the **project ID**
   it generates (something like `number-bomb-4a2f9`); you need it later.
3. Google Analytics is not used here. Turn it off.

## 2. Turn on anonymous sign-in

**Build → Authentication → Get started → Sign-in method → Anonymous → Enable.**

This is what lets a stranger play without an account. Each phone gets a
throwaway identity the security rules use to hold a seat.

## 3. Create the database

**Build → Firestore Database → Create database.**

- Pick **Production mode**. The starter rules lock everything; you replace them
  in step 6 with the tested ones in `firestore.rules`.
- Choose a region near your players. It cannot be changed later.

## 4. Register a web app and copy the config

**Project settings (gear icon) → General → Your apps → Web (`</>`).**

Give it a nickname, skip Firebase Hosting setup in that dialog, and copy the
`firebaseConfig` object it shows you.

Then, in this folder:

```bash
cp config.example.js config.js
```

Open `config.js` and paste your values in, then commit it:

```bash
git add config.js && git commit -m "Point at my Firebase project"
```

> **Committing this is fine.** A Firebase web config is a *public identifier*,
> not a credential — it ships to every browser that loads the page, so there is
> nothing to leak. What actually protects your data is `firestore.rules`, which
> is why those rules are tested. GitHub Pages serves whatever is committed, so
> `config.js` has to be in the repository for rooms to work there.
>
> If you would rather lock the key down anyway: Google Cloud console → APIs &
> Services → Credentials → your browser key → set an **HTTP referrer**
> restriction to your own domain.

## 5. Publish the security rules

The rules are the only thing between your game and the open internet, and they
do **not** travel with the page — they are deployed to Firebase separately.

```bash
npm install                 # installs firebase-tools locally
npx firebase login          # opens a browser
npx firebase use --add      # choose the project you just made
npm run deploy:rules
```

Do this again any time you edit `firestore.rules`.

## 6. Put the page somewhere public

Pick one.

### Option A — GitHub Pages (you are already on GitHub)

1. Push everything, `config.js` included.
2. Repo → **Settings → Pages**.
3. **Source: Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
4. Wait a minute. Your link is `https://<your-user>.github.io/number-bomb/`.

The repository has to be **public** for Pages on a free plan.

Then tell Firebase the domain is yours: **Authentication → Settings →
Authorized domains → Add domain →** `<your-user>.github.io`. Anonymous sign-in
usually works without this, but adding it costs one click and is required the
moment you add any other sign-in method.

### Option B — Firebase Hosting

```bash
npm run deploy              # hosting + rules in one go
```

Prints `https://<project-id>.web.app`. Its domain is authorized already, and
rules ship with the same command.

---

**Either way, that URL is the link.** Send it to the group. Anyone who opens it
can tap *Start a game* or *Join a game* and play — no account, no install.

---

## Checking it worked

Open the link on your phone and a friend's. You should see **Open room** in the
top-left badge and this on the home screen:

> Synced rooms are open to anyone with the link — no account, no sign-in.

If it instead says *No room server on this copy*, the page did not find a valid
`config.js` — check it deployed and that `projectId` is really yours and not
still `YOUR_PROJECT_ID`.

---

## The rules, and what they actually stop

`firestore.rules` is the only thing standing between your game and the open
internet, so it is tested rather than assumed:

```bash
npm run test:rules          # 22 tests against the Firestore emulator
```

Verified refused, for a player writing straight to the database with the game
page's own credentials and bypassing the interface completely:

- moving when it is not their turn
- guessing outside the live range, or on a boundary
- moving the wrong bound, or moving it somewhere other than the guess
- skipping a player, or keeping the turn
- rewriting or truncating earlier moves in the log
- re-arming the bomb, editing the roster, or changing the forfeit
- blaming someone else for a detonation
- playing on after the bomb has gone off
- starting or dealing a rematch when not the host
- deleting someone else's room, or taking someone else's seat

### What they do NOT stop

**A determined player can read the bomb.** It is stored scrambled rather than as
a plain number, but every client needs the value to judge its own guess against
it, and security rules can validate a write — they cannot compute one. So
adjudicating a guess server-side is impossible with rules alone.

If that matters to your group, the fix is a **Cloud Function**: keep the bomb in
a document nobody can read, and have the function take a guess, compare it, and
write the result. That needs the **Blaze** plan, which requires a card on file
even though this usage sits inside its free allowance. I have not built it — say
the word and I will.

For a game about who eats the last spring roll, the current honour-system
version is the right trade. It is also exactly what pass-the-phone avoids,
since on one device there is nothing to inspect.

---

## Housekeeping

- **Rooms persist.** Nothing deletes them. If they pile up, remove old ones in
  the Firestore console; the host of a room is the only person the rules let
  delete it.
- **Anonymous accounts accumulate** too, one per browser. Authentication →
  Users lets you clear them out. Wiping them costs players their seats in any
  room still running.
- **Redeploy after editing rules**: `npm run deploy:rules`. Rules live in
  Firebase, not in the page, so pushing to GitHub does not update them.
- Consider turning on **App Check** if the link ever escapes your friend group
  and you want to keep other sites from hammering your quota.
