"use strict";
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const contentPath = path.join(__dirname, "../bsky-edit-detector-extension/bsky-edit-detector-extension/content.js");
const content = fs.readFileSync(contentPath, "utf8");
const did = "did:plc:ye5jmhlzzrkagjupeczg6tfg";
const rkey = "3mzxyic7bd22m";
const uri = `at://${did}/app.bsky.feed.post/${rkey}`;
const sourceUrl = `https://bsky.app/profile/vonneudeck.com/post/${rkey}`;

async function inspectPost(readResponse) {
  const badges = [];
  let diagram = "";
  const elements = new Map();
  const dialog = {
    open: false,
    setAttribute() {},
    addEventListener() {},
    showModal() { this.open = true; },
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, {});
      return elements.get(selector);
    },
  };
  const container = {
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild(badge) { badges.push(badge.textContent); },
  };
  const context = vm.createContext({
    URL, URLSearchParams, AbortSignal, console,
    matchMedia: () => ({ matches: false }),
    crypto: { randomUUID: () => "test" },
    mermaid: {
      initialize() {},
      async render(_id, source) {
        diagram = source;
        return { svg: "<svg></svg>" };
      },
    },
    BskyEditDetectorConnection: { reportRequest() {} },
    document: {
      createElement(tag) { return tag === "dialog" ? dialog : { addEventListener() {} }; },
      body: { appendChild() {} },
    },
    fetch: async (url) => ({ ok: true, status: 200, json: async () => readResponse(new URL(url)) }),
    container, did, rkey, sourceUrl,
  });
  const startup = content.indexOf("  const observer = new MutationObserver");
  assert.ok(startup >= 0);
  await vm.runInContext(`${content.slice(0, startup)}
    const parsed = { actor: did, rkey, sourceUrl };
    addThreadDataButton(container, parsed);
    return getPostEditInfo(parsed).then(async (info) => {
      if (info.isEdited) addBadge(container, info);
      await showThreadData(parsed);
    });
  })();`, context);
  assert.equal(dialog.open, true);
  assert.equal(elements.get('[role="status"]').hidden, true);
  return { badges, diagram, table: elements.get(".bsky-edit-detector-thread-content").innerHTML };
}

function fixture(parent, threadCid = "current") {
  return (url) => {
    if (url.hostname === "plc.directory") return {};
    if (url.pathname.endsWith("/com.atproto.repo.getRecord")) {
      return { uri, cid: "current", value: { $type: "app.bsky.feed.post", text: "Aktuelle Fassung" } };
    }
    assert.equal(url.pathname, "/xrpc/app.bsky.feed.getPostThread");
    assert.equal(url.searchParams.get("uri"), uri);
    return {
      thread: {
        post: { uri, cid: threadCid, indexedAt: "2026-11-10T18:00:00Z", record: { text: "Text des Posts\nZweite Zeile" } },
        replies: [
          { post: { indexedAt: "2026-11-10T19:00:00Z", record: { text: "Spätere Antwort", reply: { parent } } } },
          { post: {
            author: { handle: "langer-account.beispiel.bsky.social" },
            indexedAt: "2026-11-10T17:00:00Z",
            record: { text: "Antwort mit <Test> & Text", reply: { parent } },
          } },
        ],
      },
    };
  };
}

async function check() {
  const changed = await inspectPost(fixture({ uri, cid: "previous" }));
  assert.deepEqual(changed.badges, ["Thread-Daten", "✏️ bearbeitet"]);
  assert.match(changed.table, /<code>previous<\/code>.*CID weicht ab/);
  assert.ok(changed.table.includes("Text des Posts\nZweite Zeile"));
  assert.ok(changed.table.includes("Antwort mit &lt;Test&gt; &amp; Text"));
  assert.match(changed.diagram, /version1\["Referenzierte Fassung<br\/>CID previous<br\/>Zeitpunkt unbekannt"\]/);
  assert.match(changed.diagram, /version1 -\.->\|referenziert von\| reply2/);
  assert.match(changed.diagram, /reply2 --> current/);
  assert.match(changed.diagram, /current --> reply1/);
  assert.match(changed.diagram, /Aktuelle Fassung<br\/>Indexiert am 10\.11\.2026.*<br\/>CID current<br\/><br\/>Aktuelle Fassung/);
  assert.match(changed.diagram, /Antwort<br\/>@langer-account\.beispiel\.bsky\.social<br\/>Indexiert am/);
  assert.match(changed.diagram, /Antwort mit #60;Test#62; #38; Text/);
  const unchanged = await inspectPost(fixture({ uri, cid: "current" }));
  assert.deepEqual(unchanged.badges, ["Thread-Daten"]);
  assert.match(unchanged.table, /Stimmt überein/);
  assert.doesNotMatch(unchanged.diagram, /Referenzierte Fassung/);
  assert.match(unchanged.diagram, /Bezug auf CID current/);
  const differentUri = await inspectPost(fixture({ uri: uri + "other", cid: "previous" }));
  assert.deepEqual(differentUri.badges, ["Thread-Daten"]);
  assert.doesNotMatch(differentUri.table, /CID weicht ab/);
  assert.doesNotMatch(differentUri.diagram, /Bezug auf CID/);
  const outdatedThread = await inspectPost(fixture({ uri, cid: "previous" }, "outdated-thread"));
  assert.deepEqual(outdatedThread.badges, ["Thread-Daten"]);
  assert.match(outdatedThread.table, /Thread-Ansicht und Record liefern unterschiedliche CIDs/);
  if (process.argv.includes("--live")) {
    const { badges, diagram, table } = await inspectPost((url) => JSON.parse(
      execFileSync("curl.exe", ["-fsS", "--max-time", "10", url.href], { encoding: "utf8" })
    ));
    assert.deepEqual(badges, ["Thread-Daten", "✏️ bearbeitet"]);
    assert.equal((table.match(/CID weicht ab/g) || []).length, 2);
    assert.equal((diagram.match(/Bezug auf CID bafyreiaxp6vbmgwai/g) || []).length, 2);
    assert.match(diagram, /reply2 --> reply1[\s\S]*reply1 --> current/);
    assert.match(diagram, /Ist er dann zuhause geblieben/);
    assert.match(diagram, /Erich Mühsam war das, nicht Brecht/);
    console.log(`PASS: Live-Post ${sourceUrl} erhält das Badge „bearbeitet“ und zeigt zwei abweichende CID-Referenzen.`);
  }
  console.log("PASS: CID-Vergleich prüft die Post-URI und die aktuelle Record-Fassung.");
}

check().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
