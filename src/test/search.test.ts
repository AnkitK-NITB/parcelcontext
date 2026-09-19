import { test } from "node:test";
import assert from "node:assert/strict";
import { searchPacks, snippetAround } from "../search";
import { ContextPack, PACK_FORMAT, PackSection } from "../types";

const sec = (
  kind: PackSection["kind"],
  title: string,
  content: string
): PackSection => ({ id: `${title}-id`, kind, title, content });

const pack = (name: string, sections: PackSection[], description = ""): ContextPack => ({
  format: PACK_FORMAT,
  id: `${name}-id`,
  name,
  description,
  source: "local chat history",
  createdAt: "2026-09-16T00:00:00.000Z",
  reviewedAt: "2026-09-16T00:00:00.000Z",
  sections,
});

const LIBRARY: ContextPack[] = [
  pack(
    "Kusto latency queries",
    [
      sec("goal", "Find slow reads", "Investigate storage read latency with Kusto."),
      sec("convention", "Query style", "Always filter by cluster before joining."),
    ],
    "Queries used during latency investigations"
  ),
  pack(
    "Parser retry work",
    [
      sec("decision", "Backoff policy", "Retry three times with exponential backoff."),
      sec("openQuestion", "Timeout value", "Is thirty seconds the right ceiling?"),
    ]
  ),
];

test("an empty query returns the whole library once", () => {
  const hits = searchPacks(LIBRARY, "");
  assert.equal(hits.length, LIBRARY.length);
  assert.ok(hits.every((h) => h.section === undefined));
});

test("matches a pack by its name", () => {
  const hits = searchPacks(LIBRARY, "kusto");
  assert.ok(hits.some((h) => !h.section && h.pack.name === "Kusto latency queries"));
});

test("matches content inside a section", () => {
  const hits = searchPacks(LIBRARY, "exponential");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].section?.title, "Backoff policy");
  assert.equal(hits[0].pack.name, "Parser retry work");
});

test("every term must match, so extra words narrow the result", () => {
  const broad = searchPacks(LIBRARY, "retry");
  const narrow = searchPacks(LIBRARY, "retry exponential");
  assert.ok(narrow.length < broad.length, "adding a term should narrow");
  assert.ok(narrow.length >= 1);
});

test("a term present in no pack returns nothing", () => {
  assert.equal(searchPacks(LIBRARY, "kubernetes").length, 0);
});

test("search is case insensitive", () => {
  assert.equal(
    searchPacks(LIBRARY, "KUSTO").length,
    searchPacks(LIBRARY, "kusto").length
  );
});

test("a name match outranks a body match", () => {
  const hits = searchPacks(LIBRARY, "kusto");
  assert.equal(hits[0].section, undefined, "the pack itself should rank first");
});

test("matches the section kind label as well as its text", () => {
  const hits = searchPacks(LIBRARY, "open questions");
  assert.ok(hits.some((h) => h.section?.kind === "openQuestion"));
});

test("a snippet is centred on the match and marks what it cut", () => {
  const text =
    "one two three four five six seven eight nine ten NEEDLE eleven twelve thirteen fourteen fifteen sixteen";
  const out = snippetAround(text, ["needle"], 40);
  assert.ok(out.includes("NEEDLE"), `snippet lost the match: ${out}`);
  assert.ok(out.length <= 44);
  assert.ok(out.startsWith("…"));
});

test("short text is returned whole without ellipsis", () => {
  assert.equal(snippetAround("short and sweet", ["sweet"], 90), "short and sweet");
});

test("a snippet falls back to the start when nothing matches", () => {
  const out = snippetAround("a".repeat(200), ["zzz"], 30);
  assert.ok(out.endsWith("…"));
  assert.ok(out.length <= 31);
});
