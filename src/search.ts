import { ContextPack, PackSection, kindLabel } from "./types";

/**
 * Search across the library.
 *
 * A pack is only useful if you can find what is inside it, and by the time a
 * scan has produced twenty packs of eight sections each, the tree alone is not
 * enough. Matching runs over section content as well as pack names.
 */

export interface PackHit {
  pack: ContextPack;
  /** Set when the match was inside a section rather than the pack itself. */
  section?: PackSection;
  score: number;
  /** The matched text, trimmed around the first hit for display. */
  snippet: string;
}

function normalize(s: string): string {
  return s.toLowerCase();
}

function terms(query: string): string[] {
  return normalize(query)
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Cuts a window around the first matching term so the hit is visible. */
export function snippetAround(text: string, needles: string[], width = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= width) return flat;

  const lower = flat.toLowerCase();
  let at = -1;
  for (const n of needles) {
    const i = lower.indexOf(n);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return flat.slice(0, width) + "…";

  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(flat.length, start + width);
  return (start > 0 ? "…" : "") + flat.slice(start, end).trim() + (end < flat.length ? "…" : "");
}

function countHits(haystack: string, needles: string[]): number {
  const lower = normalize(haystack);
  let n = 0;
  for (const t of needles) if (lower.includes(t)) n++;
  return n;
}

/**
 * Ranks packs and sections against a query. Every term must appear somewhere in
 * the candidate, so adding words narrows rather than widens -- which is what a
 * search box is expected to do.
 */
export function searchPacks(packs: ContextPack[], query: string): PackHit[] {
  const needles = terms(query);
  if (needles.length === 0) {
    return packs.map((p) => ({
      pack: p,
      score: 0,
      snippet: p.description || `${p.sections.length} sections`,
    }));
  }

  const hits: PackHit[] = [];
  for (const pack of packs) {
    const packText = `${pack.name} ${pack.description} ${pack.source}`;
    if (countHits(packText, needles) === needles.length) {
      hits.push({
        pack,
        score: 100 + countHits(pack.name, needles) * 10,
        snippet: pack.description || `${pack.sections.length} sections`,
      });
    }

    for (const section of pack.sections) {
      const sectionText = `${kindLabel(section.kind)} ${section.title} ${section.content}`;
      if (countHits(sectionText, needles) !== needles.length) continue;
      hits.push({
        pack,
        section,
        score:
          50 +
          countHits(section.title, needles) * 8 +
          countHits(section.content, needles),
        snippet: snippetAround(section.content, needles),
      });
    }
  }

  return hits.sort(
    (a, b) => b.score - a.score || a.pack.name.localeCompare(b.pack.name)
  );
}
