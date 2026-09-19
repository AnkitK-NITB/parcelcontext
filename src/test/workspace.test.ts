import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeWorkspaceUri,
  sameWorkspace,
  workspaceLabel,
  readSession,
} from "../chatStore";

// The same WSL folder is recorded under several URI forms depending on which
// window wrote the entry. Treating them as different workspaces both split the
// list and stopped the current workspace from ever matching.

const FORMS = [
  "vscode-remote://wsl%2Bubuntu/home/ankit/sample-core",
  "vscode-remote://wsl+ubuntu/home/ankit/sample-core",
  "file://wsl.localhost/Ubuntu/home/ankit/sample-core",
  "\\\\wsl.localhost\\Ubuntu\\home\\ankit\\sample-core",
];

test("every WSL URI form normalises to the same key", () => {
  const keys = new Set(FORMS.map((f) => normalizeWorkspaceUri(f, "Ubuntu")));
  assert.equal(keys.size, 1, `expected one key, got ${[...keys].join(" | ")}`);
});

test("all WSL URI forms compare as the same workspace", () => {
  for (const a of FORMS) {
    for (const b of FORMS) {
      assert.ok(sameWorkspace(a, b, "Ubuntu"), `${a} !== ${b}`);
    }
  }
});

// Inside WSL the extension host reports a plain posix file:// URI while the
// stored entry uses vscode-remote. This is the case that produced
// "filtered to workspace file:///home/ankit/sample-core: 0 of 493 files".
test("a posix file URI from inside WSL matches its stored remote form", () => {
  assert.ok(
    sameWorkspace(
      "file:///home/ankit/sample-core",
      "vscode-remote://wsl%2Bubuntu/home/ankit/sample-core",
      "Ubuntu"
    )
  );
  assert.ok(
    sameWorkspace(
      "file:///home/ankit/sample-core",
      "file://wsl.localhost/Ubuntu/home/ankit/sample-core",
      "Ubuntu"
    )
  );
});

test("a host that cannot name its distro still matches on path", () => {
  assert.ok(
    sameWorkspace(
      "file:///home/ankit/sample-core",
      "vscode-remote://wsl+ubuntu/home/ankit/sample-core",
      "?"
    )
  );
});

test("a windows drive mounted into WSL resolves to the windows folder", () => {
  assert.ok(
    sameWorkspace(
      "file:///mnt/c/Users/me/source/repos/CSI-HHS",
      "file:///c%3A/Users/me/source/repos/CSI-HHS",
      "Ubuntu"
    )
  );
});

test("different folders on the same distro stay distinct", () => {
  assert.equal(
    sameWorkspace("vscode-remote://wsl+ubuntu/home/ankit/sample-core","vscode-remote://wsl+ubuntu/home/ankit/sample-edge","Ubuntu"),
    false
  );
});

test("the same folder on a different distro is not the same workspace", () => {
  assert.equal(
    sameWorkspace("vscode-remote://wsl+ubuntu/home/ankit/sample-core","vscode-remote://wsl+debian/home/ankit/sample-core","Ubuntu"),
    false
  );
});

test("windows paths compare case-insensitively and ignore a trailing slash", () => {
  assert.ok(
    sameWorkspace(
      "file:///c%3A/Users/me/source/repos/CSI-HHS",
      "file:///C:/Users/me/source/repos/csi-hhs/"
    )
  );
});

test("distinct windows folders with the same name stay distinct", () => {
  assert.equal(
    sameWorkspace(
      "file:///c:/Users/me/source/repos/CSI-HHS",
      "file:///c:/Users/me/Downloads/CSI-HHS"
    ),
    false
  );
});

test("an undefined side never matches", () => {
  assert.equal(sameWorkspace(undefined, "file:///c:/x"), false);
  assert.equal(sameWorkspace("file:///c:/x", undefined), false);
  assert.equal(sameWorkspace(undefined, undefined), false);
});

test("the label is the last path segment whatever the scheme", () => {
  assert.equal(
    workspaceLabel("vscode-remote://wsl+ubuntu/home/ankit/sample-core"),
    "sample-core"
  );
  assert.equal(workspaceLabel("file:///c:/src/Storage-XStore"), "Storage-XStore");
  assert.equal(workspaceLabel("file:///c:/src/Storage-XStore/"), "Storage-XStore");
  assert.equal(workspaceLabel(undefined), "unknown workspace");
});

// VS Code writes a session as an incremental journal, and an agent turn lands
// in two stages: the request is appended carrying only the model's opening
// line, then the answer is appended to requests[n].response afterwards. Reading
// only the first write kept "I'll read that README" and dropped every command
// the answer contained, which is what made packs come out empty.

const JOURNAL = [
  JSON.stringify({
    kind: 0,
    v: { version: 3, sessionId: "s1", requests: [] },
  }),
  JSON.stringify({ kind: 1, k: ["customTitle"], v: "Remote devshell setup for DPU" }),
  JSON.stringify({
    kind: 2,
    k: ["requests"],
    v: [
      {
        requestId: "r1",
        timestamp: 42,
        modelId: "copilot/mai-code-1.1-flash",
        message: { text: "How do I enable remote devshell?" },
        response: [
          { kind: "mcpServersStarting", didStartServerIds: [] },
          { kind: "progressTaskSerialized", content: { value: "Optimized tool selection" } },
          { value: "I'll read the README first." },
        ],
      },
    ],
  }),
  JSON.stringify({ kind: 1, k: ["requests", 0, "result"], v: { timings: {} } }),
  JSON.stringify({
    kind: 2,
    k: ["requests", 0, "response"],
    v: [
      { value: "Set the port:\n" },
      { value: "reg add HKLM\\...\\DPCProxy\\Parameters /v TcpPort /d 20110 /f\n" },
      { value: "Then restart with sc start devproxy." },
    ],
  }),
].join("\n");

test("a journal session is replayed, not read once", () => {
  const parsed = readSession(JOURNAL, "jsonl");
  assert.ok(parsed, "the journal format must be recognised");
  assert.equal(parsed!.title, "Remote devshell setup for DPU");
  assert.equal(parsed!.turns.length, 1);
  assert.equal(parsed!.turns[0].prompt, "How do I enable remote devshell?");
  assert.equal(parsed!.turns[0].modelId, "copilot/mai-code-1.1-flash");
  assert.equal(parsed!.turns[0].timestamp, 42);
});

test("the answer appended after the request survives", () => {
  const { response } = readSession(JOURNAL, "jsonl")!.turns[0];
  assert.match(response, /TcpPort \/d 20110/, "the real answer must be kept");
  assert.match(response, /sc start devproxy/);
  assert.ok(
    response.length > 100,
    `expected more than the opening line, got ${response.length} chars`
  );
});

test("tool traffic and progress chrome are left out of the response", () => {
  const { response } = readSession(JOURNAL, "jsonl")!.turns[0];
  assert.doesNotMatch(response, /Optimized tool selection/);
  assert.doesNotMatch(response, /mcpServersStarting/);
});

test("streamed parts join without inserting breaks mid-sentence", () => {
  const { response } = readSession(JOURNAL, "jsonl")!.turns[0];
  assert.match(response, /Set the port:\nreg add/);
});

test("the older whole-file and transcript formats still read", () => {
  const plain = JSON.stringify({
    customTitle: "Old session",
    requests: [{ message: "hi", response: "there", modelId: "m", timestamp: 1 }],
  });
  const asJson = readSession(plain, "json");
  assert.equal(asJson?.turns[0].response, "there");
  // A misfiled extension must not cost the whole session.
  assert.equal(readSession(plain, "jsonl")?.turns[0].response, "there");

  const transcript = [
    JSON.stringify({ type: "session.start", data: { model: "m", title: "T" } }),
    JSON.stringify({ type: "user.message", data: { content: "q" } }),
    JSON.stringify({ type: "assistant.message", data: { content: "a" } }),
  ].join("\n");
  assert.equal(readSession(transcript, "jsonl")?.turns[0].response, "a");
});

test("a file in neither shape is reported as unreadable rather than empty", () => {
  assert.equal(readSession("not json at all", "jsonl"), undefined);
  assert.equal(readSession(JSON.stringify({ nothing: true }), "json"), undefined);
});


