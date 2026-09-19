import { test } from "node:test";
import assert from "node:assert/strict";
import { PACK_FORMAT, parsePack, newPack, kindLabel } from "../types";

const valid = {
  format: PACK_FORMAT,
  id: "pack-1",
  name: "Project Handoff",
  description: "d",
  source: "atlas-web",
  createdAt: "2026-09-14T18:00:00.000Z",
  reviewedAt: "2026-09-14T18:00:00.000Z",
  sections: [
    { id: "s1", kind: "goal", title: "Goal", content: "Migrate checkout" },
  ],
};

test("parses a valid pack", () => {
  const p = parsePack(valid);
  assert.equal(p.name, "Project Handoff");
  assert.equal(p.sections.length, 1);
  assert.equal(p.sections[0].kind, "goal");
});

test("rejects a non-object", () => {
  assert.throws(() => parsePack("nope"), /not a JSON object/);
  assert.throws(() => parsePack(null), /not a JSON object/);
});

test("rejects an unknown format", () => {
  assert.throws(
    () => parsePack({ ...valid, format: "someone-elses/v9" }),
    /Unsupported pack format/
  );
});

test("rejects a pack with no name", () => {
  assert.throws(() => parsePack({ ...valid, name: "   " }), /missing a name/);
  assert.throws(() => parsePack({ ...valid, name: 42 }), /missing a name/);
});

test("rejects a pack with no sections array", () => {
  assert.throws(() => parsePack({ ...valid, sections: {} }), /missing its sections/);
});

test("rejects a section missing content", () => {
  assert.throws(
    () => parsePack({ ...valid, sections: [{ title: "t" }] }),
    /missing a title or content/
  );
});

test("coerces an unknown section kind to a note rather than throwing", () => {
  const p = parsePack({
    ...valid,
    sections: [{ title: "t", content: "c", kind: "not-a-kind" }],
  });
  assert.equal(p.sections[0].kind, "note");
  assert.equal(kindLabel(p.sections[0].kind), "Notes");
});

test("generates ids for sections that lack them", () => {
  const p = parsePack({ ...valid, sections: [{ title: "t", content: "c" }] });
  assert.ok(p.sections[0].id.length > 0);
});

test("a round trip through JSON is stable", () => {
  const p = newPack({ name: "Round Trip", sections: valid.sections as any });
  const again = parsePack(JSON.parse(JSON.stringify(p)));
  assert.equal(again.name, p.name);
  assert.equal(again.id, p.id);
  assert.equal(again.sections.length, p.sections.length);
});

test("newPack fills required metadata", () => {
  const p = newPack({ name: "X" });
  assert.equal(p.format, PACK_FORMAT);
  assert.ok(p.id);
  assert.ok(p.createdAt);
  assert.ok(p.reviewedAt);
  assert.deepEqual(p.sections, []);
});
