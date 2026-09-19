import { PackSection, SectionKind, cryptoRandomId } from "./types";

/** One prompt/response exchange lifted out of a stored chat session. */
export interface ChatTurn {
  sessionId: string;
  title: string;
  workspace: string;
  modelId: string;
  timestamp: number;
  prompt: string;
  response: string;
}

export interface ScanStats {
  sessionsSeen: number;
  sessionsSkipped: number;
  turnsSeen: number;
  turnsExcluded: number;
  valuesMasked: number;
}

export function emptyStats(): ScanStats {
  return {
    sessionsSeen: 0,
    sessionsSkipped: 0,
    turnsSeen: 0,
    turnsExcluded: 0,
    valuesMasked: 0,
  };
}

// ---------------------------------------------------------------- redaction

/**
 * High-confidence secrets. A turn containing any of these is dropped whole --
 * masking is not enough, because the surrounding sentence usually explains what
 * the secret is for.
 */
const HARD_EXCLUDE: { name: string; re: RegExp }[] = [
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "connection string", re: /(?:AccountKey|Password|Pwd)\s*=\s*[^;\s"']{8,}/i },
  { name: "bearer token", re: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}/ },
  { name: "azure PAT", re: /\b[a-z2-7]{52}\b/ },
  { name: "aws key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "assigned secret", re: /\b(?:api[_-]?key|secret|client[_-]?secret|access[_-]?token|passwd|password)\b\s*[:=]\s*["']?[^\s"']{8,}/i },
];

/** Lower-confidence values worth masking but not worth losing the turn over. */
const MASK: { name: string; re: RegExp; to: string }[] = [
  { name: "url credentials", re: /(\w+):\/\/[^\s:@/]+:[^\s:@/]+@/g, to: "$1://[redacted]@" },
  { name: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, to: "[email]" },
  { name: "guid", re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, to: "[guid]" },
  { name: "long hex", re: /\b[0-9a-f]{40,}\b/gi, to: "[hash]" },
  { name: "ip", re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, to: "[ip]" },
];

export interface RedactionResult {
  text: string;
  excluded: boolean;
  excludedBecause?: string;
  masked: number;
}

/**
 * The user asked not to be made to triage exclusions, so classification is
 * automatic. It is deliberately biased towards dropping content: a pack is a
 * shareable artefact, and a false exclusion costs one section while a false
 * inclusion can leak a credential.
 */
export function redact(text: string): RedactionResult {
  for (const rule of HARD_EXCLUDE) {
    if (rule.re.test(text)) {
      return { text: "", excluded: true, excludedBecause: rule.name, masked: 0 };
    }
  }
  let out = text;
  let masked = 0;
  for (const rule of MASK) {
    out = out.replace(rule.re, (m) => {
      masked++;
      return rule.to.startsWith("$1") ? m.replace(rule.re, rule.to) : rule.to;
    });
  }
  return { text: out, excluded: false, masked };
}

// ---------------------------------------------------------------- clustering

const STOPWORDS = new Set([
  "the","a","an","and","or","but","to","of","in","on","for","with","is","was",
  "are","were","be","been","i","we","you","it","this","that","my","me","will",
  "have","has","had","do","did","done","can","could","should","would","what",
  "how","why","when","where","which","who","not","no","yes","if","then","else",
  "from","by","at","as","so","up","out","about","into","over","just","also",
  "like","get","got","make","made","use","using","used","need","want","try",
  "trying","let","lets","please","thanks","thank","ok","okay","sure","help",
  "file","files","code","line","lines","error","errors","add","added","fix",
  "fixed","run","running","new","now","here","there","one","two","see","look",
  "your","yours","them","they","their","been","more","most","some","any","all",
  "than","then","very","much","many","well","good","best","better","same",
  "user","users","work","works","working","thing","things","way","ways","time",
  // Instruction and operations filler. People describe a topic the way they
  // would to a teammate -- "how to set up remote devshell commands" -- and all of
  // this is the sentence around the subject, not the subject. Counting it made
  // three filler words outrank the one word that identified the material.
  "setup","set","remote","command","commands","enable","enabled","enabling",
  "install","installed","configure","step","steps","guide","guides","process",
  "access","start","started","stop","create","created","check","checking",
  "issue","issues","problem","problems","question","questions","update",
  "updated","change","changed","changes","option","options","show","find",
  "explain","support","machine","machines","server","servers",
]);

export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && w.length < 30 && !STOPWORDS.has(w));
}

/** Distinctive terms for a session, by frequency. */
export function topTerms(text: string, n: number): string[] {
  const counts = new Map<string, number>();
  for (const t of terms(text)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([t]) => t);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * How much each word of a topic should count.
 *
 * A topic like "how to setup remote devshell commands" is mostly filler: "setup",
 * "remote" and "commands" appear in half the history, while "devshell" is the
 * actual subject. Counting them equally lets three filler words outscore the
 * one word that matters, which is how a devshell pack fills up with deployment
 * groups and wustack traces.
 */
export interface TopicWeights {
  /** Per-term share of a perfect score. Sums to 1 across the topic. */
  weight: Map<string, number>;
  /** Terms rare enough to be the subject rather than scenery. */
  distinctive: Set<string>;
}

/** A term in more than this share of the corpus is scenery, not a subject. */
const DISTINCTIVE_MAX_SHARE = 0.2;

/**
 * Below this many exchanges, how often a word appears says nothing useful --
 * in a handful of turns every word looks either universal or unique -- so the
 * frequency gate is not applied.
 */
const MIN_CORPUS_FOR_FREQUENCY = 25;

/**
 * A match in the answer counts less than one in the question -- people state
 * their subject when they ask -- but not so much less that answers get buried,
 * because the reusable knowledge is in the answers.
 */
const RESPONSE_WEIGHT = 0.6;

/**
 * Mentions of the subject per topic word before an exchange counts as fully
 * "about" it. Work-unit threads that call devshell once in passing should not
 * outrank a thread that discusses it throughout.
 */
const EMPHASIS_TARGET = 3;

/** How much of the score is carried by emphasis rather than bare coverage. */
const EMPHASIS_SHARE = 0.4;

function emphasisFactor(occurrences: number, topicSize: number): number {
  const saturation = Math.min(1, occurrences / (EMPHASIS_TARGET * topicSize));
  return 1 - EMPHASIS_SHARE + EMPHASIS_SHARE * saturation;
}

function scoreSets(
  inPrompt: Set<string>,
  inResponse: Set<string>,
  wanted: Set<string>,
  weights: TopicWeights,
  occurrences: number
): number {
  let coverage = 0;
  let hitDistinctive = false;
  for (const w of wanted) {
    const weight = weights.weight.get(w) ?? 1 / wanted.size;
    let got = 0;
    if (inPrompt.has(w)) got = weight;
    else if (inResponse.has(w)) got = weight * RESPONSE_WEIGHT;
    if (got > 0) {
      coverage += got;
      if (weights.distinctive.has(w)) hitDistinctive = true;
    }
  }
  // Filler words alone are not a match. Without this, an exchange that never
  // mentions the subject outranks one that is entirely about it.
  if (!hitDistinctive) return 0;
  return coverage * emphasisFactor(occurrences, wanted.size);
}

function countTopicTerms(termList: string[], wanted: Set<string>): number {
  let n = 0;
  for (const t of termList) if (wanted.has(t)) n++;
  return n;
}

/**
 * How well one exchange matches a topic the user asked for.
 *
 * Weighted towards the rare words of the topic and towards the question over
 * the answer, then scaled by how much the exchange dwells on the subject.
 */
export function topicScore(
  turn: ChatTurn,
  wanted: Set<string>,
  weights?: TopicWeights
): number {
  if (wanted.size === 0) return 0;
  const promptTerms = terms(turn.prompt + " " + turn.title);
  const responseTerms = terms(turn.response);
  return scoreSets(
    new Set(promptTerms),
    new Set(responseTerms),
    wanted,
    weights ?? flatWeights(wanted),
    countTopicTerms(promptTerms, wanted) + countTopicTerms(responseTerms, wanted)
  );
}

export function topicWeights(
  wanted: Set<string>,
  documentFrequency: Map<string, number>,
  corpusSize: number
): TopicWeights {
  const idf = new Map<string, number>();
  let total = 0;
  for (const w of wanted) {
    const df = documentFrequency.get(w) ?? 0;
    // Smoothed, so a term that appears everywhere still counts for something
    // and a term that appears nowhere cannot divide by zero.
    const value = Math.log((corpusSize + 1) / (df + 1)) + 1;
    idf.set(w, value);
    total += value;
  }

  const weight = new Map<string, number>();
  for (const [w, value] of idf) {
    weight.set(w, total > 0 ? value / total : 1 / wanted.size);
  }

  const distinctive = new Set<string>();
  if (corpusSize < MIN_CORPUS_FOR_FREQUENCY) {
    for (const w of wanted) distinctive.add(w);
  } else {
    for (const w of wanted) {
      const df = documentFrequency.get(w) ?? 0;
      if (df <= corpusSize * DISTINCTIVE_MAX_SHARE) distinctive.add(w);
    }
  }
  // Every word being common means the topic has no subject to anchor on, so
  // fall back to treating them all as one rather than rejecting everything.
  if (distinctive.size === 0) for (const w of wanted) distinctive.add(w);

  return { weight, distinctive };
}

/** Uniform weighting, for callers scoring a single turn out of context. */
function flatWeights(wanted: Set<string>): TopicWeights {
  const weight = new Map<string, number>();
  for (const w of wanted) weight.set(w, 1 / wanted.size);
  return { weight, distinctive: new Set(wanted) };
}

/** Minimum topic score for an exchange to be worth including. */
export const TOPIC_THRESHOLD = 0.34;

export interface TopicMatch {
  turns: ChatTurn[];
  /** Best score seen, so the caller can report how confident the match was. */
  best: number;
  scanned: number;
}

/**
 * Selects the exchanges relevant to a stated topic. Returns them ranked so a
 * caller can cap the volume sent to a model without losing the best material.
 */
export function selectForTopic(
  turns: ChatTurn[],
  topic: string,
  threshold = TOPIC_THRESHOLD
): TopicMatch {
  const wanted = new Set(terms(topic));
  if (wanted.size === 0) return { turns: [], best: 0, scanned: turns.length };

  // Term lists are built once: they are needed for the frequency pass and again
  // for scoring, and re-tokenising a large history twice is the expensive part.
  const prepared = turns.map((turn) => {
    const promptTerms = terms(turn.prompt + " " + turn.title);
    const responseTerms = terms(turn.response);
    return {
      turn,
      inPrompt: new Set(promptTerms),
      inResponse: new Set(responseTerms),
      occurrences:
        countTopicTerms(promptTerms, wanted) + countTopicTerms(responseTerms, wanted),
    };
  });

  const documentFrequency = new Map<string, number>();
  for (const p of prepared) {
    for (const w of wanted) {
      if (p.inPrompt.has(w) || p.inResponse.has(w)) {
        documentFrequency.set(w, (documentFrequency.get(w) ?? 0) + 1);
      }
    }
  }
  const weights = topicWeights(wanted, documentFrequency, prepared.length);

  const scored: { turn: ChatTurn; score: number }[] = [];
  let best = 0;
  for (const p of prepared) {
    const score = scoreSets(p.inPrompt, p.inResponse, wanted, weights, p.occurrences);
    if (score > best) best = score;
    if (score >= threshold) scored.push({ turn: p.turn, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return { turns: scored.map((s) => s.turn), best, scanned: turns.length };
}

export interface Cluster {
  label: string;
  turns: ChatTurn[];
  terms: string[];
}

export interface ClusterOptions {
  /** A one-off exchange is not a topic worth carrying into another workspace. */
  minTurns?: number;
  /** Surfacing fifty near-identical topics is as unhelpful as surfacing none. */
  maxClusters?: number;
  threshold?: number;
}

export const CLUSTER_DEFAULTS: Required<ClusterOptions> = {
  minTurns: 3,
  maxClusters: 15,
  threshold: 0.18,
};

/**
 * Greedy agglomeration on term overlap. Deterministic, dependency-free, and
 * good enough to separate "the storage work" from "the build pipeline work",
 * which is the granularity a pack needs.
 */
export function clusterTurns(
  turns: ChatTurn[],
  options: ClusterOptions = {}
): Cluster[] {
  const { minTurns, maxClusters, threshold } = { ...CLUSTER_DEFAULTS, ...options };

  const bySession = new Map<string, ChatTurn[]>();
  for (const t of turns) {
    bySession.set(t.sessionId, [...(bySession.get(t.sessionId) ?? []), t]);
  }

  const units = [...bySession.entries()].map(([sessionId, ts]) => ({
    sessionId,
    turns: ts,
    terms: new Set(topTerms(ts.map((t) => t.prompt + " " + t.response).join(" "), 25)),
  }));

  const clusters: { turns: ChatTurn[]; terms: Set<string> }[] = [];
  for (const u of units) {
    let best = -1;
    let bestScore = threshold;
    clusters.forEach((c, i) => {
      const s = jaccard(c.terms, u.terms);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    });
    if (best === -1) {
      clusters.push({ turns: [...u.turns], terms: new Set(u.terms) });
    } else {
      clusters[best].turns.push(...u.turns);
      for (const t of u.terms) clusters[best].terms.add(t);
    }
  }

  const result = clusters
    .map((c) => {
      const termList = topTerms(
        c.turns.map((t) => t.prompt + " " + t.response).join(" "),
        8
      );
      return { label: labelFor(c.turns, termList), turns: c.turns, terms: termList };
    })
    .filter((c) => c.turns.length >= minTurns)
    .sort((a, b) => b.turns.length - a.turns.length)
    .slice(0, maxClusters);

  disambiguate(result);
  return result;
}

/**
 * Turns the opening question of a conversation into something a person would
 * recognise later. Raw prompts make poor labels: they lead with pasted paths,
 * links and politeness, and truncate mid-word.
 */
export function cleanPrompt(text: string): string {
  let s = text;
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/`[^`]*`/g, " ");
  s = s.replace(/https?:\/\/\S+/g, " ");
  // Windows, UNC and WSL paths, then any multi-segment posix path.
  s = s.replace(/[a-zA-Z]:[\\/][^\s"'<>|]+/g, " ");
  s = s.replace(/\\\\[^\s"'<>|]+/g, " ");
  s = s.replace(/(?:\/[\w.@+-]+){2,}\/?/g, " ");
  s = s.replace(/#file:\S+/gi, " ");
  s = s.replace(/\[[^\]]*\]\([^)]*\)/g, " ");
  // Truncated attachment references keep an unclosed bracket.
  s = s.replace(/\[[^\]]*$/g, " ");
  s = s.replace(/\[[^\]]*\]/g, " ");
  s = s.replace(/["'“”]+/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

const FILLER = [
  /^(hey|hi|hello|ok|okay|so|now|also|and|but|well)\b[,\s]+/i,
  /^(can|could|would|will|pls|plz)\s+(you|u)\s+(please\s+|pls\s+)?/i,
  /^(please|kindly)\s+/i,
  /^i\s+(want|need|would\s+like|wanna|am\s+trying)\s+(to\s+|you\s+to\s+)?/i,
  /^(help|assist)\s+me\s+(to\s+|with\s+|out\s+)?/i,
  /^let'?s\s+/i,
  /^(we|i)\s+(should|need\s+to|have\s+to|must)\s+/i,
  /^(the\s+)?(question|issue|problem)\s+is\s+/i,
];

export function stripFiller(text: string): string {
  let s = text;
  for (let i = 0; i < 4; i++) {
    const before = s;
    for (const re of FILLER) s = s.replace(re, "");
    s = s.trimStart();
    if (s === before) break;
  }
  return s;
}

/** Trims to whole words so a label never ends mid-token. */
export function trimWords(s: string, maxWords: number, maxChars: number): string {
  let out = s.split(/\s+/).filter(Boolean).slice(0, maxWords).join(" ");
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars);
    const space = cut.lastIndexOf(" ");
    out = space > maxChars * 0.4 ? cut.slice(0, space) : cut;
  }
  return out.replace(/[\s,;:.\-–—]+$/, "");
}

function sentenceCase(s: string): string {
  if (!s) return s;
  // Leave an existing capital or an identifier-looking first word alone.
  if (/^[A-Z0-9]/.test(s)) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function termsLabel(termList: string[], count = 3): string {
  if (termList.length === 0) return "Untitled context";
  return termList
    .slice(0, count)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join(" · ");
}

function labelFor(turns: ChatTurn[], termList: string[]): string {
  const candidates = [
    ...turns.map((t) => t.title).filter(Boolean),
    ...turns.map((t) => t.prompt),
  ];

  for (const raw of candidates) {
    if (!raw) continue;
    if (/^(new chat|untitled|chat)$/i.test(raw.trim())) continue;
    const cleaned = stripFiller(cleanPrompt(raw));
    // A couple of words left after cleaning means the prompt was mostly a
    // pasted path or link, and the terms describe the topic better.
    if (cleaned.split(/\s+/).filter(Boolean).length < 3) continue;
    return sentenceCase(trimWords(cleaned, 9, 58));
  }
  return termsLabel(termList);
}

/** Makes repeated labels distinguishable without renaming everything. */
function disambiguate(
  clusters: { label: string; turns: ChatTurn[]; terms: string[] }[]
): void {
  const counts = new Map<string, number>();
  for (const c of clusters) {
    counts.set(c.label.toLowerCase(), (counts.get(c.label.toLowerCase()) ?? 0) + 1);
  }
  const used = new Map<string, number>();
  for (const c of clusters) {
    const key = c.label.toLowerCase();
    if ((counts.get(key) ?? 0) < 2) continue;
    const n = (used.get(key) ?? 0) + 1;
    used.set(key, n);
    const extra = c.terms.find(
      (t) => !c.label.toLowerCase().includes(t)
    );
    c.label = extra
      ? `${c.label} · ${extra.charAt(0).toUpperCase() + extra.slice(1)}`
      : `${c.label} (${n})`;
  }
}

// ---------------------------------------------------------------- synthesis

const CUES: { kind: SectionKind; res: RegExp[] }[] = [
  {
    kind: "decision",
    res: [
      /\bwe (?:decided|agreed|will use|chose|settled on|went with)\b[^.!?]*[.!?]/gi,
      /\blet'?s (?:use|go with|stick with|keep)\b[^.!?]*[.!?]/gi,
      /\binstead of [^.!?]*[.!?]/gi,
    ],
  },
  {
    kind: "convention",
    res: [
      /\balways [^.!?]*[.!?]/gi,
      /\bnever [^.!?]*[.!?]/gi,
      /\bmake sure (?:to|that) [^.!?]*[.!?]/gi,
      /\bconvention[^.!?]*[.!?]/gi,
    ],
  },
  {
    kind: "goal",
    res: [
      /\b(?:the )?goal is [^.!?]*[.!?]/gi,
      /\bwe(?:'re| are) trying to [^.!?]*[.!?]/gi,
      /\bi (?:want|need) to [^.!?]*[.!?]/gi,
    ],
  },
  {
    kind: "openQuestion",
    res: [
      /\b(?:still (?:need|unclear|open)|not sure|todo|to do|remains? (?:open|unresolved))\b[^.!?]*[.!?]/gi,
      /\bshould we [^.!?]*\?/gi,
      /\bdo we [^.!?]*\?/gi,
    ],
  },
];

const MAX_SECTION_CHARS = 400;
const MAX_SECTIONS_PER_PACK = 12;

/**
 * Pulls candidate knowledge out of a cluster using cue phrases. This is the
 * fallback when no chat model is available; the model path produces better
 * prose but this never returns nothing.
 */
export function synthesiseSections(cluster: Cluster): PackSection[] {
  const corpus = cluster.turns
    .map((t) => `${t.prompt}\n${t.response}`)
    .join("\n");

  const sections: PackSection[] = [];
  const seen = new Set<string>();

  for (const cue of CUES) {
    for (const re of cue.res) {
      for (const m of corpus.matchAll(re)) {
        const raw = m[0].replace(/\s+/g, " ").trim();
        if (raw.length < 25 || raw.length > MAX_SECTION_CHARS) continue;
        const key = raw.toLowerCase().slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);
        sections.push({
          id: cryptoRandomId(),
          kind: cue.kind,
          title: titleFrom(raw),
          content: raw,
        });
        if (sections.length >= MAX_SECTIONS_PER_PACK) break;
      }
      if (sections.length >= MAX_SECTIONS_PER_PACK) break;
    }
  }

  // Always record where this came from, so an imported pack is auditable.
  const models = [...new Set(cluster.turns.map((t) => t.modelId).filter(Boolean))];
  const sessions = new Set(cluster.turns.map((t) => t.sessionId)).size;
  sections.push({
    id: cryptoRandomId(),
    kind: "reference",
    title: "Scanned from",
    content:
      `${cluster.turns.length} exchanges across ${sessions} chat session(s)` +
      (models.length ? `, models: ${models.join(", ")}` : "") +
      `. Key terms: ${cluster.terms.join(", ")}.`,
  });

  return sections;
}

function titleFrom(s: string): string {
  const words = s.split(/\s+/).slice(0, 6).join(" ");
  return words.replace(/[.,;:!?]+$/, "").slice(0, 60);
}

// ---------------------------------------------------------------- split/merge

/**
 * A stable id for a scanned topic, so re-scanning updates the same pack instead
 * of creating a near-duplicate. Derived from the session ids in the cluster,
 * which stay constant as a conversation grows.
 */
export function clusterId(cluster: Cluster): string {
  const sessions = [...new Set(cluster.turns.map((t) => t.sessionId))].sort();
  let h = 2166136261;
  for (const s of sessions.join("|")) {
    h ^= s.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return "scan-" + (h >>> 0).toString(36);
}

export function splitSections(
  sections: PackSection[],
  moveIds: Set<string>
): { kept: PackSection[]; moved: PackSection[] } {
  const kept: PackSection[] = [];
  const moved: PackSection[] = [];
  for (const s of sections) (moveIds.has(s.id) ? moved : kept).push(s);
  return { kept, moved };
}

/** Merges section lists, dropping duplicates by normalised content. */
export function mergeSections(lists: PackSection[][]): PackSection[] {
  const out: PackSection[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const s of list) {
      const key = `${s.kind}::${s.content.replace(/\s+/g, " ").trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}
