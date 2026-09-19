import { PackSection, SectionKind, cryptoRandomId } from "./types";

/** Everything we could learn about a workspace without asking the user to type. */
export interface WorkspaceSignals {
  folderName: string;
  docs: { path: string; text: string }[];
  commits: string[];
  changedFiles: string[];
  openFiles: string[];
}

export function signalsAreThin(s: WorkspaceSignals): boolean {
  return s.docs.length === 0 && s.commits.length === 0;
}

export const DRAFT_PROMPT = `You are drafting a "context pack" for a software workspace.

A context pack captures the background a teammate would need to pick up this work:
- goal: what this work is trying to achieve
- decision: a choice already made, and why
- convention: how this team works
- openQuestion: something not yet resolved
- reference: a file, command or doc worth knowing about

Rules:
- Base every section ONLY on the evidence provided. Never invent facts.
- Prefer decisions and conventions that are visible in docs or commit history.
- Each section: a short title (2-5 words) and one or two sentences of content.
- Produce between 4 and 8 sections.
- If the evidence does not support a kind, omit that kind entirely.

Respond with JSON only, no prose, no code fence:
{"sections":[{"kind":"goal","title":"...","content":"..."}]}`;

/**
 * Model output is untrusted text. Anything malformed is dropped rather than
 * allowed to become a section the user might later share.
 */
export function parseSections(raw: string): PackSection[] | undefined {
  const cleaned = raw
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return undefined;
  }

  const sections = (parsed as { sections?: unknown })?.sections;
  if (!Array.isArray(sections)) return undefined;

  const valid: PackSection[] = [];
  for (const s of sections) {
    if (typeof s !== "object" || s === null) continue;
    const o = s as Record<string, unknown>;
    if (typeof o.title !== "string" || typeof o.content !== "string") continue;
    if (!o.title.trim() || !o.content.trim()) continue;
    valid.push({
      id: cryptoRandomId(),
      kind: asKind(o.kind),
      title: o.title.trim(),
      content: o.content.trim(),
    });
  }
  return valid.length > 0 ? valid : undefined;
}

function asKind(v: unknown): SectionKind {
  const known: SectionKind[] = [
    "goal", "decision", "convention", "openQuestion", "reference", "note",
  ];
  return known.includes(v as SectionKind) ? (v as SectionKind) : "note";
}

export function renderEvidence(s: WorkspaceSignals): string {
  const parts: string[] = [`Workspace: ${s.folderName}`];
  for (const d of s.docs) parts.push(`--- ${d.path} ---\n${d.text}`);
  if (s.commits.length) parts.push(`--- recent commits ---\n${s.commits.join("\n")}`);
  if (s.changedFiles.length)
    parts.push(`--- recently changed files ---\n${s.changedFiles.join("\n")}`);
  if (s.openFiles.length) parts.push(`--- currently open ---\n${s.openFiles.join("\n")}`);
  return parts.join("\n\n");
}

/**
 * Evidence-only draft used when no chat model is available. Produces fewer and
 * blunter sections, but never blocks the user and never invents anything.
 */
export function draftHeuristically(s: WorkspaceSignals): PackSection[] {
  const sections: PackSection[] = [];
  const push = (kind: SectionKind, title: string, content: string) =>
    sections.push({ id: cryptoRandomId(), kind, title, content });

  const readme = s.docs.find((d) => /readme/i.test(d.path));
  if (readme) {
    const firstPara = readme.text
      .split(/\n\s*\n/)
      .map((p) => p.replace(/^#+\s*/, "").trim())
      .find((p) => p.length > 40);
    if (firstPara) push("goal", "Project purpose", truncate(firstPara, 300));

    const headings = [...readme.text.matchAll(/^#{2,3}\s+(.+)$/gm)]
      .map((m) => m[1].trim())
      .slice(0, 6);
    if (headings.length) push("reference", "Documented areas", headings.join(" · "));
  }

  const instructions = s.docs.find((d) => /copilot-instructions|AGENTS/i.test(d.path));
  if (instructions) {
    push(
      "convention",
      "Stated working agreements",
      truncate(instructions.text.replace(/\s+/g, " "), 400)
    );
  }

  if (s.commits.length) {
    push(
      "reference",
      "Recent work",
      s.commits.slice(0, 8).map((c) => c.replace(/^\w+\s/, "")).join(" · ")
    );
  }

  if (s.changedFiles.length) {
    const top = topDirectories(s.changedFiles);
    if (top.length) push("reference", "Most active areas", top.join(" · "));
  }

  push(
    "openQuestion",
    "Needs your input",
    "No chat model was available, so this draft is evidence-only. Add the goals, decisions and open questions that are not written down anywhere."
  );

  return sections;
}

function topDirectories(files: string[]): string[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const dir = f.split(/[\\/]/).slice(0, 2).join("/");
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([d, n]) => `${d} (${n})`);
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n).trimEnd() + "…" : s;
}
