import { PackSection, SectionKind, cryptoRandomId } from "./types";

/**
 * Prompts and reply parsing for model-assisted scanning.
 *
 * Kept free of the vscode module so the parsing -- which handles untrusted
 * model output -- can be unit tested directly.
 */

export const NAME_PROMPT = `You are naming topics extracted from a developer's chat history.

For each numbered topic you receive, return a short descriptive name and a one
line description.

Rules for the name:
- 3 to 7 words, sentence case, no trailing punctuation
- Say what the work was about, not what the person asked for
- Never include file paths, URLs, ticket links, or quoted text
- Prefer concrete subjects: the component, the bug, the task
- Good: "Snapshot request timeout in FunOS"
- Bad: "Can you review this PR", "C:\\Users\\me\\Downloads\\notes.txt"

Rules for the description: one sentence, max 15 words, plain statement.

Respond with JSON only, no prose, no code fence:
{"topics":[{"index":0,"name":"...","description":"..."}]}`;

export const REFINE_PROMPT = `You are turning a developer's chat history into a reusable context pack.

You receive the full exchanges of one topic and a list of candidate sections that
were extracted mechanically. Those candidates are noisy: near-duplicates,
fragments, and lines that only made sense in the moment.

Capture the KNOWLEDGE, not the conversation. Most of the substance is in the
answers, not the questions.

- Write what was learned, decided, or established. Specifics matter: names of
  components, functions, files, flags, error codes, numbers, and sequences.
- Never describe the conversation itself. Write "Push operations continue on the
  same WU stack while Async operations may resume on another", not "The
  discussion covered the difference between push and async".
- Never mention "the chat", "the discussion", "the evidence", "the user", or
  "this topic".
- Merge anything that says the same thing. Keep the most specific wording.
- Drop pleasantries, fragments, and anything not reusable later.
- Each section must stand alone for someone who was not in the conversation.
- Base everything on what is present. Never invent facts. If something was left
  unresolved, record it as an openQuestion rather than guessing.

Section kinds:
- goal: what the work is trying to achieve
- decision: a choice made, and the reason
- convention: how this team or codebase does things
- openQuestion: something genuinely unresolved
- reference: a concrete pointer worth keeping (file, command, identifier, link)
- note: reusable technical detail that fits none of the above

Each section has a kind, a short title (2-5 words) and one to four sentences.
Prefer several precise sections over one broad one.

Respond with JSON only, no prose, no code fence:
{"sections":[{"kind":"decision","title":"...","content":"..."}]}`;

/** The subset of a chat model these helpers need, so they stay testable. */
export interface ModelInfo {
  readonly id: string;
  readonly name?: string;
  readonly family?: string;
  readonly version?: string;
  readonly maxInputTokens?: number;
}

/**
 * Best human-readable label for a model.
 *
 * `family` is documented as an opaque value and in some tenants every model
 * reports the same one, which makes every label identical. `name` is the only
 * field the API promises is human-readable, so it leads.
 */
export function modelDisplay(model: ModelInfo): string {
  const name = (model.name ?? "").trim();
  if (name) return name;
  const family = (model.family ?? "").trim();
  if (family) return family;
  return model.id;
}

/** Roughly how many characters fit per token, used to size evidence budgets. */
const CHARS_PER_TOKEN = 3.5;

/**
 * How much evidence to send for refinement, sized from the model's own context
 * window. Half the window leaves ample room for the instructions and the reply.
 *
 * A fixed cap here is what made packs thin: a large context window went unused
 * and most of the conversation never reached the model.
 */
export function evidenceBudget(maxInputTokens?: number): number {
  const window = (maxInputTokens ?? 8000) * CHARS_PER_TOKEN;
  return Math.max(8000, Math.min(120_000, Math.floor(window * 0.5)));
}

/** Compact context-window label, e.g. "128K context". */
export function formatContext(maxInputTokens?: number): string {
  if (!maxInputTokens || maxInputTokens <= 0) return "context unknown";
  if (maxInputTokens >= 1_000_000) {
    const m = maxInputTokens / 1_000_000;
    return `${m % 1 === 0 ? m : m.toFixed(1)}M context`;
  }
  if (maxInputTokens >= 1000) return `${Math.round(maxInputTokens / 1000)}K context`;
  return `${maxInputTokens} context`;
}

/** Everything that might distinguish two models, for pickers and diagnostics. */
export function modelDetail(model: ModelInfo): string {
  const name = modelDisplay(model);
  const bits = [
    model.family && model.family !== name ? `family ${model.family}` : "",
    model.version ? `v${model.version}` : "",
    model.maxInputTokens ? `${model.maxInputTokens.toLocaleString()} tokens` : "",
    model.id,
  ].filter(Boolean);
  return bits.join(" · ");
}

/**
 * Labels that are unique within the given set. Some tenants surface several
 * models sharing a name, and a picker of identical rows is unusable.
 */
export function uniqueLabels(models: ModelInfo[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const m of models) {
    const d = modelDisplay(m);
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const m of models) {
    const d = modelDisplay(m);
    if ((counts.get(d) ?? 0) < 2) {
      out.set(m.id, d);
      continue;
    }
    const extra =
      (m.version && m.version !== d ? m.version : "") ||
      (m.family && m.family !== d ? m.family : "") ||
      m.id.slice(-8);
    out.set(m.id, `${d} (${extra})`);
  }
  return out;
}

/** Strips prose and code fences from a model reply and parses the JSON. */
export function parseJsonReply(raw: string): unknown {
  const cleaned = raw.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
  const start = cleaned.search(/[[{]/);
  if (start === -1) return undefined;
  const open = cleaned[start];
  const close = open === "[" ? "]" : "}";
  const end = cleaned.lastIndexOf(close);
  if (end <= start) return undefined;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

export interface ClusterNaming {
  index: number;
  name: string;
  description: string;
}

export function parseNaming(raw: string): ClusterNaming[] | undefined {
  const parsed = parseJsonReply(raw);
  const list = Array.isArray(parsed)
    ? parsed
    : ((parsed as { topics?: unknown })?.topics as unknown[]);
  if (!Array.isArray(list)) return undefined;

  const out: ClusterNaming[] = [];
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    const index = Number(o.index);
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!Number.isInteger(index) || !name) continue;
    out.push({
      index,
      name: name.replace(/[.\s]+$/, "").slice(0, 70),
      description:
        typeof o.description === "string" ? o.description.trim().slice(0, 160) : "",
    });
  }
  return out.length > 0 ? out : undefined;
}

const KINDS: SectionKind[] = [
  "goal", "decision", "convention", "openQuestion", "reference", "note",
];

export function parseRefinedSections(raw: string): PackSection[] | undefined {
  const parsed = parseJsonReply(raw);
  const list = (parsed as { sections?: unknown })?.sections;
  if (!Array.isArray(list)) return undefined;

  const out: PackSection[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    const content = typeof o.content === "string" ? o.content.trim() : "";
    if (!title || !content) continue;
    const key = content.replace(/\s+/g, " ").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: cryptoRandomId(),
      kind: KINDS.includes(o.kind as SectionKind) ? (o.kind as SectionKind) : "note",
      title: title.slice(0, 60),
      content: content.slice(0, 1200),
    });
  }
  return out.length > 0 ? out : undefined;
}
