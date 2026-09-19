import * as vscode from "vscode";
import { PackStore } from "./store";
import { ContextPack, kindLabel } from "./types";

interface GetContextInput {
  query?: string;
}

/**
 * Exposes enabled context packs to Copilot via the Language Model Tool API.
 *
 * Scope is deliberately narrow: only packs the user saved, reviewed, and then
 * explicitly enabled for this workspace are ever returned.
 */
export class ContextPackTool
  implements vscode.LanguageModelTool<GetContextInput>
{
  constructor(private readonly store: PackStore) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<GetContextInput>
  ): Promise<vscode.PreparedToolInvocation> {
    const packs = await this.store.enabledPacks();
    const names = packs.map((p) => p.name).join(", ");
    return {
      invocationMessage:
        packs.length === 0
          ? "Checking enabled context packs"
          : `Reading context from ${names}`,
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetContextInput>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const packs = await this.store.enabledPacks();

    if (packs.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          "No context packs are enabled for this workspace. " +
            "The user can enable one from the ParcelContext view."
        ),
      ]);
    }

    const query = (options.input?.query ?? "").trim().toLowerCase();
    const terms = query ? query.split(/\s+/).filter(Boolean) : [];

    const rendered = packs
      .map((pack) => renderPack(pack, terms))
      .filter((text): text is string => Boolean(text));

    if (rendered.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `No sections in the enabled packs (${packs
            .map((p) => p.name)
            .join(", ")}) matched that query.`
        ),
      ]);
    }

    const preamble =
      "The following context packs were reviewed and enabled by the user for " +
      "this workspace. Treat them as the user's own stated goals, decisions " +
      "and conventions. Cite the pack name when you rely on one.";

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart([preamble, ...rendered].join("\n\n")),
    ]);
  }
}

function renderPack(pack: ContextPack, terms: string[]): string | undefined {
  const sections = terms.length
    ? pack.sections.filter((s) => {
        const hay = `${s.title} ${s.content} ${kindLabel(s.kind)}`.toLowerCase();
        return terms.some((t) => hay.includes(t));
      })
    : pack.sections;

  if (sections.length === 0) return undefined;

  const lines: string[] = [];
  lines.push(`## Context pack: ${pack.name}`);
  if (pack.description) lines.push(pack.description);
  lines.push(
    `_Source: ${pack.source} · reviewed ${formatDate(pack.reviewedAt)}_`
  );

  const grouped = new Map<string, string[]>();
  for (const s of sections) {
    const label = kindLabel(s.kind);
    const bucket = grouped.get(label) ?? [];
    bucket.push(`- **${s.title}** — ${s.content}`);
    grouped.set(label, bucket);
  }
  for (const [label, items] of grouped) {
    lines.push(`### ${label}`);
    lines.push(...items);
  }
  return lines.join("\n");
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "unknown" : d.toISOString().slice(0, 10);
}
