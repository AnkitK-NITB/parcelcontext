import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";
import { PackSection } from "./types";
import {
  DRAFT_PROMPT,
  WorkspaceSignals,
  parseSections,
  renderEvidence,
} from "./draftCore";

export {
  WorkspaceSignals,
  draftHeuristically,
  parseSections,
  signalsAreThin,
} from "./draftCore";

const exec = promisify(execFile);

const DOC_CANDIDATES = [
  "README.md",
  "readme.md",
  ".github/copilot-instructions.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "docs/README.md",
  "docs/architecture.md",
  "ARCHITECTURE.md",
];

const MAX_DOC_CHARS = 6000;

export async function collectSignals(
  folder: vscode.WorkspaceFolder
): Promise<WorkspaceSignals> {
  const docs: { path: string; text: string }[] = [];
  for (const rel of DOC_CANDIDATES) {
    try {
      const uri = vscode.Uri.joinPath(folder.uri, rel);
      const bytes = await vscode.workspace.fs.readFile(uri);
      docs.push({
        path: rel,
        text: Buffer.from(bytes).toString("utf8").slice(0, MAX_DOC_CHARS),
      });
    } catch {
      /* not present */
    }
  }

  // Also pick up a few design notes anywhere under docs/.
  if (docs.length < 3) {
    const found = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, "docs/**/*.md"),
      "**/node_modules/**",
      3
    );
    for (const uri of found) {
      const rel = vscode.workspace.asRelativePath(uri);
      if (docs.some((d) => d.path === rel)) continue;
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        docs.push({
          path: rel,
          text: Buffer.from(bytes).toString("utf8").slice(0, MAX_DOC_CHARS),
        });
      } catch {
        /* unreadable */
      }
    }
  }

  const cwd = folder.uri.fsPath;
  const commits = await git(cwd, ["log", "--oneline", "-n", "40", "--no-merges"]);
  const changed = await git(cwd, ["log", "--name-only", "--pretty=format:", "-n", "20"]);

  const openFiles = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .map((t) => (t.input as { uri?: vscode.Uri })?.uri)
    .filter((u): u is vscode.Uri => Boolean(u))
    .map((u) => vscode.workspace.asRelativePath(u))
    .slice(0, 25);

  return {
    folderName: folder.name,
    docs,
    commits,
    changedFiles: dedupe(changed).slice(0, 30),
    openFiles: dedupe(openFiles),
  };
}

async function git(cwd: string, args: string[]): Promise<string[]> {
  try {
    const { stdout } = await exec("git", args, { cwd, timeout: 8000 });
    return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/**
 * Drafts pack sections from workspace evidence using the chat model the user
 * already has available. The draft is never saved directly -- it always goes
 * through the review gate first.
 */
export async function draftWithModel(
  signals: WorkspaceSignals,
  token: vscode.CancellationToken
): Promise<PackSection[] | undefined> {
  const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
  if (models.length === 0) return undefined;

  const messages = [
    vscode.LanguageModelChatMessage.User(DRAFT_PROMPT),
    vscode.LanguageModelChatMessage.User(`Evidence:\n\n${renderEvidence(signals)}`),
  ];

  let raw = "";
  try {
    const response = await models[0].sendRequest(messages, {}, token);
    for await (const chunk of response.text) raw += chunk;
  } catch {
    return undefined;
  }

  return parseSections(raw);
}
