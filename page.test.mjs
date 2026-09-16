// Tests for the served page itself — the parts that are neither game rules nor
// security rules. No dependencies, no network, no browser: these read the
// shipped files as text so CI catches a head that was stripped or an image
// that was replaced with a huge export.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const count = needle => html.split(needle).length - 1;

test("index.html declares og:title, og:description, og:image and twitter:card", () => {
  // A link with no preview is the least-clicked thing in a group chat, and
  // every share the game produces goes through these four tags.
  for (const tag of ['property="og:title"', 'property="og:description"',
                     'property="og:image"', 'name="twitter:card"']) {
    assert.equal(count(tag), 1, `${tag} should appear exactly once`);
  }
  assert.match(html, /content="summary_large_image"/, "card type must be the large one");
  // og:image has to be absolute or nothing will fetch it.
  assert.match(html, /property="og:image" content="https:\/\/[^"]+\/og\.png"/,
    "og:image must be an absolute URL");
});

test("og.png exists and is under 300 KB", () => {
  const bytes = statSync(new URL("./og.png", import.meta.url)).size;
  assert.ok(bytes > 0, "og.png must not be empty");
  assert.ok(bytes < 300 * 1024, `og.png is ${(bytes / 1024).toFixed(0)} KB, over the 300 KB budget`);
});

test("handlers that take an argument are not wired to listeners bare", () => {
  // submitGuess(forced) is called both from the guess box and from the
  // last-number button. Passed to addEventListener bare, the click Event
  // arrives as `forced` and the guess becomes "[object MouseEvent]" — the
  // Guess button stops working while Enter still does, which is easy to miss.
  const bare = [...html.matchAll(/addEventListener\("click",\s*([A-Za-z_$][\w$]*)\s*\)/g)]
    .map(m => m[1]);
  for (const fn of bare){
    const sig = html.match(new RegExp(`function ${fn}\\(([^)]*)\\)`));
    assert.ok(sig, `could not find function ${fn}`);
    assert.equal(sig[1].trim(), "",
      `${fn} takes an argument, so it must be wrapped: () => ${fn}()`);
  }
});
