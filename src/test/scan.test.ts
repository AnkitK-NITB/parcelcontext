import { test } from "node:test";
import assert from "node:assert/strict";
import {
  redact,
  clusterTurns,
  clusterId,
  synthesiseSections,
  splitSections,
  mergeSections,
  topTerms,
  jaccard,
  selectForTopic,
  topicScore,
  topicWeights,
  cleanPrompt,
  stripFiller,
  trimWords,
  ChatTurn,
} from "../scanCore";
import {
  parseNaming,
  parseRefinedSections,
  parseJsonReply,
  modelDisplay,
  uniqueLabels,
  formatContext,
  evidenceBudget,
} from "../scanModelCore";
import { PackSection } from "../types";

const turn = (o: Partial<ChatTurn> = {}): ChatTurn => ({
  sessionId: "s1",
  title: "",
  workspace: "w1",
  modelId: "gpt",
  timestamp: 1,
  prompt: "",
  response: "",
  ...o,
});

// ---- redaction: the part that stops a pack leaking a credential ----

test("drops a turn containing a private key", () => {
  const r = redact("here you go\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n");
  assert.equal(r.excluded, true);
  assert.equal(r.excludedBecause, "private key");
  assert.equal(r.text, "");
});

test("drops a storage connection string", () => {
  const r = redact(
    "use DefaultEndpointsProtocol=https;AccountName=x;AccountKey=abc123def456ghi789;"
  );
  assert.equal(r.excluded, true);
});

test("drops bearer tokens, PATs, AWS and GitHub keys, and JWTs", () => {
  for (const s of [
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
    "pat is abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst",
    "AKIAIOSFODNN7EXAMPLE",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ]) {
    assert.equal(redact(s).excluded, true, `should have excluded: ${s.slice(0, 30)}`);
  }
});

test("drops an assigned secret whatever it is called", () => {
  assert.equal(redact('api_key: "s3cr3t-value-here"').excluded, true);
  assert.equal(redact("client_secret=abcd1234efgh5678").excluded, true);
  assert.equal(redact("password = hunter2hunter2").excluded, true);
});

test("keeps ordinary prose that merely mentions the word secret", () => {
  const r = redact("We should not put the secret in source control.");
  assert.equal(r.excluded, false);
});

test("masks identifiers without destroying the sentence", () => {
  const r = redact(
    "ping alice@contoso.com about 3f2504e0-4f89-11d3-9a0c-0305e82c3301 on 10.1.2.3"
  );
  assert.equal(r.excluded, false);
  assert.ok(r.masked >= 3);
  assert.ok(!r.text.includes("alice@contoso.com"));
  assert.ok(!r.text.includes("10.1.2.3"));
  assert.ok(r.text.includes("ping"), "surrounding prose should survive");
});

test("masks credentials embedded in a URL", () => {
  const r = redact("clone https://user:pa55word@github.com/org/repo.git");
  assert.equal(r.excluded, false);
  assert.ok(!r.text.includes("pa55word"));
});

// ---- clustering ----

test("splits unrelated topics into separate clusters", () => {
  const turns = [
    turn({ sessionId: "a", prompt: "kusto query storage latency telemetry", response: "kusto cluster storage latency" }),
    turn({ sessionId: "b", prompt: "kusto storage latency dashboard telemetry", response: "storage latency kusto" }),
    turn({ sessionId: "c", prompt: "react component button styling css", response: "styling react component css" }),
  ];
  const cl = clusterTurns(turns, { minTurns: 1 });
  assert.ok(cl.length >= 2, `expected separate topics, got ${cl.length}`);
});

test("prefers a real session title as the cluster label", () => {
  const cl = clusterTurns([
    turn({ sessionId: "a", title: "Storage latency investigation", prompt: "kusto latency", response: "latency" }),
  ], { minTurns: 1 });
  assert.equal(cl[0].label, "Storage latency investigation");
});

test("falls back to distinctive terms when the title is a placeholder", () => {
  const cl = clusterTurns([
    turn({ sessionId: "a", title: "New Chat", prompt: "parser retry backoff logic", response: "parser retry backoff" }),
  ], { minTurns: 1 });
  assert.notEqual(cl[0].label, "New Chat");
  assert.ok(cl[0].label.length > 0);
});

test("jaccard and topTerms behave", () => {
  assert.equal(jaccard(new Set(["a"]), new Set(["a"])), 1);
  assert.equal(jaccard(new Set(["a"]), new Set(["b"])), 0);
  assert.equal(jaccard(new Set(), new Set(["a"])), 0);
  const t = topTerms("parser parser parser retry retry backoff", 2);
  assert.deepEqual(t, ["parser", "retry"]);
});

// ---- synthesis ----

test("extracts decisions, conventions and open questions from prose", () => {
  const cl = clusterTurns([
    turn({
      sessionId: "a",
      prompt: "We decided to keep the existing API contract stable for now.",
      response:
        "Always run the integration tests before merging. Should we version the payments endpoint?",
    }),
  ], { minTurns: 1 });
  const sections = synthesiseSections(cl[0]);
  const kinds = new Set(sections.map((s) => s.kind));
  assert.ok(kinds.has("decision"));
  assert.ok(kinds.has("convention"));
  assert.ok(kinds.has("openQuestion"));
});

test("always records provenance so an imported pack is auditable", () => {
  const cl = clusterTurns([turn({ sessionId: "a", prompt: "nothing quotable", response: "ok" })], { minTurns: 1 });
  const sections = synthesiseSections(cl[0]);
  const ref = sections.find((s) => s.title === "Scanned from");
  assert.ok(ref);
  assert.match(ref!.content, /chat session/);
});

// ---- split and merge ----

const sec = (id: string, content: string): PackSection => ({
  id,
  kind: "note",
  title: id,
  content,
});

test("split moves only the chosen sections", () => {
  const all = [sec("a", "one"), sec("b", "two"), sec("c", "three")];
  const { kept, moved } = splitSections(all, new Set(["b"]));
  assert.deepEqual(kept.map((s) => s.id), ["a", "c"]);
  assert.deepEqual(moved.map((s) => s.id), ["b"]);
});

test("merge drops duplicate content but keeps distinct sections", () => {
  const merged = mergeSections([
    [sec("a", "same thing"), sec("b", "unique one")],
    [sec("c", "same  thing"), sec("d", "unique two")],
  ]);
  assert.equal(merged.length, 3);
});

test("merge preserves order of first appearance", () => {
  const merged = mergeSections([[sec("a", "first")], [sec("b", "second")]]);
  assert.deepEqual(merged.map((s) => s.content), ["first", "second"]);
});

// ---- labels: a raw prompt is a bad name ----

test("strips pasted paths, links and code from a prompt", () => {
  assert.equal(
    cleanPrompt('crashdump analysis "\\\\wsl.localhost\\Ubuntu\\home\\ankit\\wkld-cr'),
    "crashdump analysis"
  );
  assert.equal(
    cleanPrompt("review C:\\Users\\me\\Downloads\\notes.txt today"),
    "review today"
  );
  assert.equal(cleanPrompt("see https://example.com/x for details"), "see for details");
  assert.equal(cleanPrompt("fix ```let x = 1``` please"), "fix please");
});

test("drops an unterminated attachment reference", () => {
  assert.equal(
    cleanPrompt("can you review this PR? [Pull request 10001016: wkld: reject"),
    "can you review this PR?"
  );
});

test("removes leading politeness and intent filler", () => {
  assert.equal(stripFiller("can you review this PR?"), "review this PR?");
  assert.equal(stripFiller("please help me to fix the parser"), "fix the parser");
  assert.equal(stripFiller("I want to add retries"), "add retries");
  assert.equal(stripFiller("so now can you check the build"), "check the build");
});

test("never truncates a label mid-word", () => {
  const out = trimWords("investigate the snapshot request timeout behaviour", 9, 30);
  assert.ok(out.length <= 30);
  assert.ok(!out.endsWith("beha"), `truncated mid-word: ${out}`);
  assert.ok(/\w$/.test(out));
});

test("a prompt that is only a pasted path falls back to key terms", () => {
  const cl = clusterTurns(
    [
      turn({
        sessionId: "a",
        prompt: "C:\\Users\\me\\Downloads\\BOSS_SNAP.txt",
        response: "snapshot transcripts request boss snapshot transcripts",
      }),
    ],
    { minTurns: 1 }
  );
  assert.ok(!cl[0].label.includes("C:\\"), `label kept a path: ${cl[0].label}`);
  assert.ok(cl[0].label.length > 0);
});

test("repeated labels are made distinguishable", () => {
  const cl = clusterTurns(
    [
      turn({ sessionId: "a", prompt: "fix the parser retry logic", response: "alpha alpha alpha" }),
      turn({ sessionId: "b", prompt: "fix the parser retry logic", response: "beta beta beta" }),
    ],
    { minTurns: 1, threshold: 0.99 }
  );
  if (cl.length === 2) {
    assert.notEqual(cl[0].label, cl[1].label, "duplicate labels should be disambiguated");
  }
});

// ---- topic selection: building a pack for one stated subject ----

test("selects the exchanges about a stated topic and rejects the rest", () => {
  const turns = [
    turn({ sessionId: "a", prompt: "kusto query for storage latency", response: "use the latency table" }),
    turn({ sessionId: "b", prompt: "how do I style this react button", response: "use css modules" }),
    turn({ sessionId: "c", prompt: "storage latency spike in kusto dashboard", response: "check the cluster" }),
  ];
  const got = selectForTopic(turns, "kusto storage latency");
  assert.equal(got.scanned, 3);
  assert.equal(got.turns.length, 2);
  assert.ok(got.turns.every((t) => /kusto|latency/i.test(t.prompt)));
});

test("results come back ranked, strongest first", () => {
  const turns = [
    turn({ sessionId: "a", prompt: "latency only", response: "" }),
    turn({ sessionId: "b", prompt: "kusto storage latency dashboard", response: "" }),
  ];
  const got = selectForTopic(turns, "kusto storage latency", 0.2);
  assert.equal(got.turns[0].sessionId, "b", "the fuller match should lead");
});

test("a topic mentioned only in an answer scores lower than one asked about", () => {
  const asked = turn({ sessionId: "a", prompt: "kusto storage latency", response: "" });
  const answered = turn({ sessionId: "b", prompt: "what happened", response: "kusto storage latency" });
  const wanted = new Set(["kusto", "storage", "latency"]);
  assert.ok(topicScore(asked, wanted) > topicScore(answered, wanted));
});

test("an unmatched topic returns nothing but still reports what it read", () => {
  const turns = [turn({ sessionId: "a", prompt: "react button styling", response: "css" })];
  const got = selectForTopic(turns, "kubernetes ingress");
  assert.equal(got.turns.length, 0);
  assert.equal(got.scanned, 1);
  assert.equal(got.best, 0);
});

test("a topic of only stopwords matches nothing rather than everything", () => {
  const turns = [turn({ sessionId: "a", prompt: "anything at all", response: "x" })];
  assert.equal(selectForTopic(turns, "the and of").turns.length, 0);
});

test("best score is reported even when nothing clears the threshold", () => {
  const turns = [turn({ sessionId: "a", prompt: "kusto only", response: "" })];
  const got = selectForTopic(turns, "kusto storage latency dashboards", 0.99);
  assert.equal(got.turns.length, 0);
  assert.ok(got.best > 0, "a near miss should still report its score");
});

// "How to setup remote devshell commands" is mostly filler. Scoring every word
// equally let two BOSS pipeline threads that never mention devshell take the top
// two places, while the exchange matching all four terms ranked second to last,
// because its matches were in the answer. The pack came back full of deployment
// groups and wustack traces.

function corpus(subjectTurns: ChatTurn[]): ChatTurn[] {
  // Filler words have to be common for frequency to recognise them as filler.
  const filler: ChatTurn[] = [];
  for (let i = 0; i < 40; i++) {
    filler.push(
      turn({
        sessionId: "f" + i,
        prompt: "setup the remote commands for the pipeline",
        response: "run the setup commands on the remote agent",
      })
    );
  }
  return [...filler, ...subjectTurns];
}

test("filler words alone do not make a match", () => {
  const noise = turn({
    sessionId: "noise",
    prompt: "how do I setup remote commands for the regression pipeline",
    response: "register the deployment group and run the setup commands",
  });
  const real = turn({
    sessionId: "real",
    prompt: "devshell notes",
    response: "run devshell -Qc10.0.0.1:20110 to reach the DPU",
  });

  const got = selectForTopic(corpus([noise, real]), "how to setup remote devshell commands");
  const ids = got.turns.map((t) => t.sessionId);
  assert.ok(ids.includes("real"), "the exchange about the subject must be kept");
  assert.ok(
    !ids.includes("noise"),
    "an exchange that never mentions the subject must not match"
  );
});

test("the subject outranks filler even when it is only in the answer", () => {
  const noise = turn({
    sessionId: "noise",
    prompt: "setup remote commands on the pipeline agent",
    response: "the setup is a remote commands registration",
  });
  const real = turn({
    sessionId: "real",
    prompt: "what did we learn",
    response: "devshell needs the remote proxy enabled before commands work",
  });

  const got = selectForTopic(corpus([noise, real]), "how to setup remote devshell commands");
  assert.equal(got.turns[0].sessionId, "real", "the subject match should lead");
});

test("a rare word carries more of the score than a common one", () => {
  const df = new Map([
    ["setup", 90],
    ["remote", 80],
    ["commands", 70],
    ["devshell", 3],
  ]);
  const wanted = new Set(["setup", "remote", "commands", "devshell"]);
  const w = topicWeights(wanted, df, 100);

  assert.ok(
    w.weight.get("devshell")! > w.weight.get("setup")!,
    "the subject must outweigh the filler"
  );
  assert.ok(w.distinctive.has("devshell"));
  assert.ok(!w.distinctive.has("setup"), "a word in 90% of turns is scenery");
  const total = [...w.weight.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, "weights should sum to one");
});

test("instruction filler is stripped from a topic, leaving the subject", () => {
  assert.deepEqual(topTerms("how to setup remote devshell commands", 10), ["devshell"]);
  assert.deepEqual(topTerms("steps to install and configure the server", 10), []);
  // Real subjects must survive.
  assert.ok(topTerms("kusto storage latency", 10).includes("kusto"));
  assert.ok(topTerms("wustack overflow in funos", 10).includes("wustack"));
});

test("dwelling on the subject beats mentioning it once", () => {
  const passing = turn({
    sessionId: "passing",
    prompt: "work unit notes",
    response: "we ran the work unit and checked it with devshell once",
  });
  const about = turn({
    sessionId: "about",
    prompt: "work unit notes",
    response:
      "devshell needs the proxy first, then devshell connects, then devshell peek " +
      "returns json, and devshell reports the version",
  });
  const wanted = new Set(["devshell"]);
  assert.ok(
    topicScore(about, wanted) > topicScore(passing, wanted),
    "an exchange that dwells on the subject should rank higher"
  );
});

test("parses a naming reply, tolerating fences and prose", () => {
  const out = parseNaming(
    'Sure!\n```json\n{"topics":[{"index":0,"name":"Snapshot request timeout","description":"Why snapshots time out."}]}\n```'
  );
  assert.equal(out?.length, 1);
  assert.equal(out![0].index, 0);
  assert.equal(out![0].name, "Snapshot request timeout");
});

test("accepts a bare array of topics", () => {
  const out = parseNaming('[{"index":2,"name":"Retry hardening"}]');
  assert.equal(out?.[0].index, 2);
  assert.equal(out?.[0].description, "");
});

test("drops naming entries with no usable name or index", () => {
  assert.equal(parseNaming('{"topics":[{"index":0,"name":"  "}]}'), undefined);
  assert.equal(parseNaming('{"topics":[{"name":"no index"}]}'), undefined);
  assert.equal(parseNaming("not json at all"), undefined);
});

test("trims trailing punctuation from a model-supplied name", () => {
  const out = parseNaming('{"topics":[{"index":0,"name":"Parser retries."}]}');
  assert.equal(out?.[0].name, "Parser retries");
});

test("parses refined sections and drops duplicates", () => {
  const out = parseRefinedSections(
    '{"sections":[{"kind":"decision","title":"Keep contract","content":"Do not break the API."},{"kind":"note","title":"Dup","content":"Do not break the API."},{"kind":"convention","title":"Small PRs","content":"Open small PRs."}]}'
  );
  assert.equal(out?.length, 2);
});

test("coerces an unknown refined kind to note and rejects empties", () => {
  const out = parseRefinedSections(
    '{"sections":[{"kind":"speculation","title":"T","content":"C"},{"title":"","content":"x"}]}'
  );
  assert.equal(out?.length, 1);
  assert.equal(out![0].kind, "note");
});

test("returns undefined when a model reply has no usable sections", () => {
  assert.equal(parseRefinedSections('{"sections":[]}'), undefined);
  assert.equal(parseRefinedSections("I cannot help with that"), undefined);
});

// ---- model display and evidence sizing ----

test("prefers the human-readable name over the opaque family", () => {
  assert.equal(
    modelDisplay({ id: "x", name: "GPT-4o mini", family: "oswe-vscode-modelID" }),
    "GPT-4o mini"
  );
});

test("falls back to family, then id, when name is missing", () => {
  assert.equal(modelDisplay({ id: "x", family: "gpt-4o" }), "gpt-4o");
  assert.equal(modelDisplay({ id: "only-id" }), "only-id");
  assert.equal(modelDisplay({ id: "x", name: "   ", family: "" }), "x");
});

test("models sharing a name are made distinguishable", () => {
  const labels = uniqueLabels([
    { id: "a1", name: "Claude", version: "3.5" },
    { id: "b2", name: "Claude", version: "4.0" },
    { id: "c3", name: "GPT-4o" },
  ]);
  assert.notEqual(labels.get("a1"), labels.get("b2"));
  assert.equal(labels.get("c3"), "GPT-4o", "a unique name should be left alone");
});

test("falls back to an id fragment when nothing else distinguishes", () => {
  const labels = uniqueLabels([
    { id: "aaaaaaaa1111", name: "Same" },
    { id: "bbbbbbbb2222", name: "Same" },
  ]);
  assert.notEqual(labels.get("aaaaaaaa1111"), labels.get("bbbbbbbb2222"));
});

test("context size is shown compactly", () => {
  assert.equal(formatContext(128000), "128K context");
  assert.equal(formatContext(1000000), "1M context");
  assert.equal(formatContext(1500000), "1.5M context");
  assert.equal(formatContext(800), "800 context");
  assert.equal(formatContext(undefined), "context unknown");
  assert.equal(formatContext(0), "context unknown");
});

// The evidence budget is what caused packs to come out thin: a fixed 5000 char
// cap meant a large context window went almost entirely unused.
test("the evidence budget scales with the model's context window", () => {
  assert.ok(
    evidenceBudget(128000) > evidenceBudget(8000),
    "a bigger window should allow more evidence"
  );
});

test("the evidence budget stays within sane bounds", () => {
  assert.ok(evidenceBudget(1000) >= 8000, "never starve a small model");
  assert.ok(evidenceBudget(10_000_000) <= 120_000, "never send an unbounded request");
  assert.ok(evidenceBudget(undefined) >= 8000);
});

// ---- stable identity: re-scanning must update, not duplicate ----

test("the same sessions always produce the same cluster id", () => {
  const turns = [
    turn({ sessionId: "s1", prompt: "kusto latency storage", response: "latency" }),
    turn({ sessionId: "s2", prompt: "kusto latency storage dashboard", response: "latency" }),
  ];
  const a = clusterTurns(turns, { minTurns: 1 }).map(clusterId);
  const b = clusterTurns(turns, { minTurns: 1 }).map(clusterId);
  assert.deepEqual(a, b);
  assert.ok(a[0].startsWith("scan-"));
});

test("cluster id survives a conversation growing", () => {
  const before = [turn({ sessionId: "s1", prompt: "parser retry backoff", response: "ok" })];
  const after = [
    ...before,
    turn({ sessionId: "s1", prompt: "parser retry backoff again", response: "more" }),
  ];
  const idBefore = clusterId(clusterTurns(before, { minTurns: 1 })[0]);
  const idAfter = clusterId(clusterTurns(after, { minTurns: 1 })[0]);
  assert.equal(idBefore, idAfter);
});

test("different sessions produce different cluster ids", () => {
  const a = clusterId(clusterTurns([turn({ sessionId: "s1", prompt: "alpha work", response: "a" })], { minTurns: 1 })[0]);
  const b = clusterId(clusterTurns([turn({ sessionId: "s2", prompt: "alpha work", response: "a" })], { minTurns: 1 })[0]);
  assert.notEqual(a, b);
});

test("re-scanning merges into the existing pack rather than duplicating", () => {
  // Simulates the upsert: prior sections plus freshly synthesised ones.
  const prior = [sec("p1", "We decided to keep the contract stable.")];
  const fresh = [
    sec("f1", "We decided to keep the contract stable."),
    sec("f2", "Always run integration tests."),
  ];
  const merged = mergeSections([prior, fresh]);
  assert.equal(merged.length, 2, "the repeated decision should not be duplicated");
});






