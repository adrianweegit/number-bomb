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

// --- share text -------------------------------------------------------------
// The builders live in the app layer, so they are extracted the same way
// engine.test.mjs extracts the engine: by marker. Building them here with the
// longest legal inputs is what stops a copy edit quietly pushing a share past
// what a chat app will show.
const shareSrc = html.split("// ===== SHARE TEXT START =====")[1]
                     .split("// ===== SHARE TEXT END =====")[0];
const SHARE = new Function(`${shareSrc}\nreturn { inviteText };`)();

test("invite text stays under 320 characters with a 120-character forfeit", () => {
  const text = SHARE.inviteText(
    "4F2K",
    "x".repeat(120),                                   // the rules cap penalty at 120
    "https://adrianweegit.github.io/number-bomb/"      // the live origin
  );
  assert.ok(text.length < 320, `invite text is ${text.length} characters`);
  assert.match(text, /room 4F2K/, "the code belongs in the text");
  assert.match(text, /\?r=4F2K$/, "the link must carry the room code");
});
