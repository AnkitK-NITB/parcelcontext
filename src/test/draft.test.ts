import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSections, draftHeuristically, signalsAreThin } from "../draftCore";
import type { WorkspaceSignals } from "../draftCore";

const signals = (o: Partial<WorkspaceSignals> = {}): WorkspaceSignals => ({
  folderName: "atlas-web",
  docs: [],
  commits: [],
  changedFiles: [],
  openFiles: [],
  ...o,
});

// ---- parsing untrusted model output ----

test("parses a clean JSON draft", () => {
  const s = parseSections(
    '{"sections":[{"kind":"goal","title":"Ship checkout","content":"Migrate the flow."}]}'
  );
  assert.equal(s?.length, 1);
  assert.equal(s![0].kind, "goal");
  assert.ok(s![0].id);
});

test("tolerates a fenced code block", () => {
  const s = parseSections(
    '```json\n{"sections":[{"kind":"decision","title":"T","content":"C"}]}\n```'
  );
  assert.equal(s?.length, 1);
  assert.equal(s![0].kind, "decision");
});

test("tolerates prose wrapped around the JSON", () => {
  const s = parseSections(
    'Sure! Here you go:\n{"sections":[{"kind":"note","title":"T","content":"C"}]}\nHope that helps.'
  );
  assert.equal(s?.length, 1);
});

test("returns undefined for unparseable output", () => {
  assert.equal(parseSections("I could not do that."), undefined);
  assert.equal(parseSections(""), undefined);
  assert.equal(parseSections("{ not json"), undefined);
});

test("returns undefined when sections is not an array", () => {
  assert.equal(parseSections('{"sections":"nope"}'), undefined);
});

test("drops malformed sections but keeps good ones", () => {
  const s = parseSections(
    '{"sections":[{"kind":"goal","title":"Keep","content":"C"},{"title":"no content"},{"kind":"goal","title":"  ","content":"blank title"}]}'
  );
  assert.equal(s?.length, 1);
  assert.equal(s![0].title, "Keep");
});

test("coerces an unknown kind to a note", () => {
  const s = parseSections(
    '{"sections":[{"kind":"wishful-thinking","title":"T","content":"C"}]}'
  );
  assert.equal(s![0].kind, "note");
});

test("returns undefined when every section is malformed", () => {
  assert.equal(parseSections('{"sections":[{"title":"only"}]}'), undefined);
});

// ---- evidence gating ----

test("thin signals are detected so nothing is drafted from nothing", () => {
  assert.equal(signalsAreThin(signals()), true);
  assert.equal(signalsAreThin(signals({ commits: ["abc fix thing"] })), false);
  assert.equal(
    signalsAreThin(signals({ docs: [{ path: "README.md", text: "hi" }] })),
    false
  );
});

// ---- heuristic fallback ----

test("the heuristic draft uses real evidence and flags its own limits", () => {
  const out = draftHeuristically(
    signals({
      docs: [
        {
          path: "README.md",
          text:
            "# Atlas Web\n\nAtlas Web is the customer facing checkout surface for the storefront platform.\n\n## Setup\n\n## Testing\n",
        },
      ],
      commits: ["a1b2c3 add retry to payments client", "d4e5f6 split checkout module"],
      changedFiles: ["src/api/pay.ts", "src/api/cart.ts", "docs/adr.md"],
    })
  );

  const goal = out.find((s) => s.kind === "goal");
  assert.ok(goal, "expected a goal derived from the README");
  assert.match(goal!.content, /checkout surface/i);

  const refs = out.filter((s) => s.kind === "reference");
  assert.ok(refs.length >= 2);

  // It must never pretend to be complete when no model was available.
  const open = out.find((s) => s.kind === "openQuestion");
  assert.ok(open);
  assert.match(open!.content, /evidence-only/i);
});

test("the heuristic draft still produces something from commits alone", () => {
  const out = draftHeuristically(signals({ commits: ["a1 fix flaky test"] }));
  assert.ok(out.length >= 1);
  assert.ok(out.every((s) => s.title && s.content));
});
