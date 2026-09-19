export const PACK_FORMAT = "parcelcontext.pack/v1";
export const PACK_EXTENSION = "ctxpack";

/** A single reviewed unit of knowledge inside a pack. */
export interface PackSection {
  id: string;
  kind: SectionKind;
  title: string;
  content: string;
}

export type SectionKind =
  | "goal"
  | "decision"
  | "convention"
  | "openQuestion"
  | "reference"
  | "note";

export const SECTION_KINDS: { kind: SectionKind; label: string; hint: string }[] = [
  { kind: "goal", label: "Goals", hint: "What this work is trying to achieve" },
  { kind: "decision", label: "Decisions", hint: "Choices already made, and why" },
  { kind: "convention", label: "Conventions", hint: "How this team works" },
  { kind: "openQuestion", label: "Open questions", hint: "Not yet resolved" },
  { kind: "reference", label: "References", hint: "Files, queries, links worth keeping" },
  { kind: "note", label: "Notes", hint: "Anything else you reviewed" },
];

/**
 * A portable, reviewable unit of context.
 *
 * Deliberately contains only what the user selected and reviewed. It does not
 * carry chat history, model state, or credentials of any kind.
 */
export interface ContextPack {
  format: typeof PACK_FORMAT;
  id: string;
  name: string;
  description: string;
  /** Where the knowledge was assembled, for provenance only. Grants no access. */
  source: string;
  createdAt: string;
  reviewedAt: string;
  sections: PackSection[];
}

export function newPack(partial: Partial<ContextPack> & { name: string }): ContextPack {
  const now = new Date().toISOString();
  return {
    format: PACK_FORMAT,
    id: partial.id ?? cryptoRandomId(),
    name: partial.name,
    description: partial.description ?? "",
    source: partial.source ?? "unknown",
    createdAt: partial.createdAt ?? now,
    reviewedAt: partial.reviewedAt ?? now,
    sections: partial.sections ?? [],
  };
}

export function cryptoRandomId(): string {
  // Stable, dependency-free id.
  return (
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10)
  );
}

/** Validates an untrusted object parsed from a .ctxpack file. */
export function parsePack(raw: unknown): ContextPack {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Pack file is not a JSON object.");
  }
  const o = raw as Record<string, unknown>;
  if (o.format !== PACK_FORMAT) {
    throw new Error(
      `Unsupported pack format: ${String(o.format)}. Expected ${PACK_FORMAT}.`
    );
  }
  if (typeof o.name !== "string" || !o.name.trim()) {
    throw new Error("Pack is missing a name.");
  }
  if (!Array.isArray(o.sections)) {
    throw new Error("Pack is missing its sections.");
  }
  const sections: PackSection[] = o.sections.map((s, i) => {
    if (typeof s !== "object" || s === null) {
      throw new Error(`Section ${i} is not an object.`);
    }
    const sec = s as Record<string, unknown>;
    if (typeof sec.title !== "string" || typeof sec.content !== "string") {
      throw new Error(`Section ${i} is missing a title or content.`);
    }
    return {
      id: typeof sec.id === "string" ? sec.id : cryptoRandomId(),
      kind: isSectionKind(sec.kind) ? sec.kind : "note",
      title: sec.title,
      content: sec.content,
    };
  });

  return {
    format: PACK_FORMAT,
    id: typeof o.id === "string" ? o.id : cryptoRandomId(),
    name: o.name,
    description: typeof o.description === "string" ? o.description : "",
    source: typeof o.source === "string" ? o.source : "unknown",
    createdAt: typeof o.createdAt === "string" ? o.createdAt : new Date().toISOString(),
    reviewedAt: typeof o.reviewedAt === "string" ? o.reviewedAt : new Date().toISOString(),
    sections,
  };
}

function isSectionKind(v: unknown): v is SectionKind {
  return (
    typeof v === "string" &&
    SECTION_KINDS.some((k) => k.kind === v)
  );
}

export function kindLabel(kind: SectionKind): string {
  return SECTION_KINDS.find((k) => k.kind === kind)?.label ?? "Notes";
}
