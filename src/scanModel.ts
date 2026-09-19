import * as vscode from "vscode";
import { PackSection } from "./types";
import { Cluster, ChatTurn } from "./scanCore";
import {
  NAME_PROMPT,
  REFINE_PROMPT,
  ClusterNaming,
  parseNaming,
  parseRefinedSections,
  evidenceBudget,
} from "./scanModelCore";

export {
  ClusterNaming,
  parseNaming,
  parseRefinedSections,
  parseJsonReply,
  modelDisplay,
  modelDetail,
  uniqueLabels,
  formatContext,
  evidenceBudget,
} from "./scanModelCore";

/**
 * Model-assisted naming and section refinement.
 *
 * Heuristics can only echo what was typed, so topics end up named after a
 * pasted path or half a sentence. A model reads the exchange and says what it
 * was actually about, and can collapse the near-duplicate sections that cue
 * matching inevitably produces.
 *
 * Every entry point degrades to undefined rather than throwing: no model, no
 * consent, no quota, or a malformed reply all fall back to the heuristic.
 */

/** Preference order when no model has been chosen explicitly. */
const FAMILY_PREFERENCE = [/mai/i, /mini/i, /fast/i, /4o/i, /sonnet/i];

const CONFIG_SECTION = "parcelcontext.scan";


export async function listModels(): Promise<vscode.LanguageModelChat[]> {
  try {
    return await vscode.lm.selectChatModels({ vendor: "copilot" });
  } catch {
    return [];
  }
}

export function modelEnabled(): boolean {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<boolean>("useModel", true);
}

/**
 * Reasoning effort is not a first-class field on the request. It is passed
 * through modelOptions, which the API documents as model-specific, so a model
 * that does not understand the key simply ignores it.
 */
export function reasoningEffort(): string {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>("reasoningEffort", "default")
    .trim();
}

function requestOptions(): vscode.LanguageModelChatRequestOptions {
  const options: vscode.LanguageModelChatRequestOptions = {
    justification:
      "ParcelContext is naming topics found in your local chat history and cleaning up the extracted sections.",
  };
  const effort = reasoningEffort();
  if (effort && effort !== "default") {
    options.modelOptions = { reasoningEffort: effort, reasoning_effort: effort };
  }
  return options;
}

/**
 * Resolves the model to use: the one configured if it is still available,
 * otherwise the preference order, which puts MAI families first.
 */
export async function pickModel(): Promise<vscode.LanguageModelChat | undefined> {
  if (!modelEnabled()) return undefined;

  const models = await listModels();
  if (models.length === 0) return undefined;

  const preferred = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>("model", "")
    .trim();
  if (preferred) {
    // id is the only field guaranteed unique, so it is what gets stored, but
    // accept the others so a hand-edited setting still resolves.
    const exact = models.find(
      (m) => m.id === preferred || m.name === preferred || m.family === preferred
    );
    if (exact) return exact;
  }

  for (const re of FAMILY_PREFERENCE) {
    const hit = models.find(
      (m) => re.test(m.name ?? "") || re.test(m.family ?? "") || re.test(m.id)
    );
    if (hit) return hit;
  }
  return models[0];
}

async function ask(
  model: vscode.LanguageModelChat,
  prompt: string,
  evidence: string,
  token: vscode.CancellationToken,
  log?: (msg: string) => void
): Promise<string | undefined> {
  try {
    const response = await model.sendRequest(
      [
        vscode.LanguageModelChatMessage.User(prompt),
        vscode.LanguageModelChatMessage.User(evidence),
      ],
      requestOptions(),
      token
    );
    let out = "";
    for await (const chunk of response.text) out += chunk;
    return out;
  } catch (err) {
    // Swallowing this silently is how a pack of raw cue-matched fragments ends
    // up looking like a finished pack. Falling back is still right, but the
    // reason has to be recoverable.
    const e = err as { message?: string; code?: string };
    log?.(
      `model request failed (${e?.code ?? "no code"}): ${e?.message ?? String(err)}` +
        ` [evidence ${evidence.length} chars]`
    );
    return undefined;
  }
}

/**
 * Questions only, for naming. The opening question states the subject, and
 * keeping this small is what lets one request name every topic at once.
 */
function promptDigest(turns: ChatTurn[], maxChars: number): string {
  const parts: string[] = [];
  let used = 0;
  for (const t of turns) {
    const line = t.prompt.replace(/\s+/g, " ").trim().slice(0, 240);
    if (!line) continue;
    if (used + line.length > maxChars) break;
    parts.push("- " + line);
    used += line.length;
  }
  return parts.join("\n");
}

/**
 * Full exchanges, for refinement.
 *
 * The answers are where the reusable knowledge lives: a question says what was
 * asked, an answer says what was learned. Sending prompts alone produced packs
 * that described the conversation instead of carrying its content.
 */
function exchangeDigest(turns: ChatTurn[], maxChars: number): string {
  const parts: string[] = [];
  let used = 0;
  for (const [i, t] of turns.entries()) {
    const q = t.prompt.replace(/\s+/g, " ").trim();
    const a = t.response.replace(/\s+/g, " ").trim();
    if (!q && !a) continue;

    const block = [
      `### Exchange ${i + 1}`,
      q ? `Asked: ${q}` : "",
      a ? `Answered: ${a}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    if (used + block.length > maxChars) {
      // Keep a truncated tail rather than dropping the exchange entirely.
      const room = maxChars - used;
      if (room > 400) parts.push(block.slice(0, room) + "…");
      break;
    }
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n\n");
}

/**
 * Names every topic in one request. One call for the whole list keeps the
 * picker responsive; per-topic calls would take longer than the scan itself.
 */
export async function nameClusters(
  model: vscode.LanguageModelChat,
  clusters: Cluster[],
  token: vscode.CancellationToken
): Promise<Map<number, ClusterNaming> | undefined> {
  const evidence = clusters
    .map((c, i) =>
      [
        `## Topic ${i}`,
        `Key terms: ${c.terms.slice(0, 8).join(", ")}`,
        `Exchanges: ${c.turns.length}`,
        "Opening questions:",
        promptDigest(c.turns, 700),
      ].join("\n")
    )
    .join("\n\n");

  const raw = await ask(model, NAME_PROMPT, evidence, token);
  if (!raw) return undefined;
  const parsed = parseNaming(raw);
  if (!parsed) return undefined;
  return new Map(parsed.map((p) => [p.index, p]));
}

/**
 * Rewrites one topic's sections. Run only for topics the user chose to keep,
 * so the expensive pass is never spent on material that gets discarded.
 */
export async function refineSections(
  model: vscode.LanguageModelChat,
  cluster: Cluster,
  candidates: PackSection[],
  token: vscode.CancellationToken,
  log?: (msg: string) => void
): Promise<PackSection[] | undefined> {
  const full = evidenceBudget(model.maxInputTokens);

  // A request that is too large is the likeliest reason for a refusal, and the
  // character-per-token estimate is only an estimate, so a failure is retried
  // on a smaller slice before giving up on the model entirely.
  for (const [attempt, budget] of [full, Math.floor(full / 3)].entries()) {
    if (token.isCancellationRequested) return undefined;
    const exchanges = exchangeDigest(cluster.turns, budget);

    // More material supports more sections; a short topic should not be padded.
    const target =
      exchanges.length > 40_000 ? "8 to 20" : exchanges.length > 12_000 ? "6 to 14" : "4 to 10";

    const evidence = [
      `Topic key terms: ${cluster.terms.join(", ")}`,
      `Exchanges available: ${cluster.turns.length}`,
      "",
      "## Conversation",
      exchanges,
      "",
      "## Candidate sections extracted mechanically",
      ...candidates.map((c) => `- [${c.kind}] ${c.title}: ${c.content}`),
      "",
      `Produce ${target} sections.`,
    ].join("\n");

    const raw = await ask(model, REFINE_PROMPT, evidence, token, log);
    if (raw) {
      const parsed = parseRefinedSections(raw);
      if (parsed) return parsed;
      log?.(`model reply could not be parsed as sections (${raw.length} chars)`);
    }
    if (attempt === 0) log?.(`retrying refinement on a smaller slice of evidence`);
  }
  return undefined;
}

