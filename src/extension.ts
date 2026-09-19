import * as vscode from "vscode";
import * as os from "os";
import { PackStore } from "./store";
import { PackTreeProvider, PackTreeItem } from "./tree";
import { ContextPackTool } from "./packTool";
import { FreshnessTracker } from "./freshness";
import {
  collectSignals,
  draftHeuristically,
  draftWithModel,
  signalsAreThin,
} from "./draft";
import { pickMany } from "./ui";
import {
  scanSessions,
  listWorkspaces,
  workspaceLabel,
  sameWorkspace,
} from "./chatStore";
import {
  pickModel,
  listModels,
  modelDisplay,
  modelDetail,
  uniqueLabels,
  formatContext,
  nameClusters,
  refineSections,
  ClusterNaming,
} from "./scanModel";
import {
  clusterTurns,
  clusterId,
  synthesiseSections,
  splitSections,
  mergeSections,
  selectForTopic,
  topTerms,
  Cluster,
} from "./scanCore";
import { searchPacks, PackHit } from "./search";
import {
  ContextPack,
  PACK_EXTENSION,
  PackSection,
  cryptoRandomId,
  kindLabel,
  newPack,
} from "./types";

const ALL_SCOPE = "__all__";

interface ScopeChoice {
  uri: string;
  label: string;
}

/**
 * Asks which workspace's history to read. The current workspace leads, because
 * that is nearly always the answer, but it is never assumed.
 */
async function chooseScope(
  output: vscode.OutputChannel,
  title: string
): Promise<ScopeChoice | undefined> {
  const workspaces = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "ParcelContext: finding workspaces" },
    async () => listWorkspaces((m) => output.appendLine(`[probe] ${m}`))
  );

  type ScopeItem = vscode.QuickPickItem & { uri?: string };
  const current = currentWorkspaceUri();
  const mine = current
    ? workspaces.find((w) => sameWorkspace(w.uri, current))
    : undefined;
  const others = workspaces.filter((w) => w !== mine);

  const items: ScopeItem[] = [];
  if (current) {
    items.push({
      label: `$(folder-active) ${mine?.label ?? workspaceLabel(current)}`,
      description: mine
        ? `${mine.sessions} sessions · this workspace`
        : "this workspace · no chat history found",
      detail: current,
      uri: mine?.uri ?? current,
    });
  }
  if (others.length) {
    items.push({ label: "Other workspaces", kind: vscode.QuickPickItemKind.Separator });
    for (const w of others) {
      items.push({
        label: w.label,
        description: `${w.sessions} sessions`,
        detail: w.uri,
        uri: w.uri,
      });
    }
  }
  items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
  items.push({
    label: "$(globe) Every workspace",
    description: `${workspaces.length} workspaces`,
    detail: "Search all chat history on this machine",
    uri: ALL_SCOPE,
  });

  const picked = await vscode.window.showQuickPick(items, {
    title,
    matchOnDetail: true,
  });
  if (!picked?.uri) return undefined;
  return { uri: picked.uri, label: picked.label };
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("ParcelContext");
  context.subscriptions.push(output);

  const version = context.extension.packageJSON.version ?? "unknown";
  output.appendLine(
    `ParcelContext ${version} activated · ${vscode.env.remoteName ?? "local"} · ${context.extensionPath}`
  );

  const store = new PackStore(context);
  const freshness = new FreshnessTracker(context);
  const tree = new PackTreeProvider(store, freshness);

  context.subscriptions.push(freshness);

  const view = vscode.window.createTreeView("parcelcontext.library", {
    treeDataProvider: tree,
  });
  context.subscriptions.push(view);

  // Keep the active model visible in the view header rather than buried in
  // settings, so it is obvious what a scan is about to use.
  //
  // Models are often not registered yet when this extension activates, and
  // selectChatModels legitimately returns an empty list until they are. So the
  // header is refreshed on every signal that could change the answer rather
  // than resolved once at startup.
  const refreshViewDescription = async () => {
    const cfg = vscode.workspace.getConfiguration("parcelcontext.scan");
    if (!cfg.get<boolean>("useModel", true)) {
      view.description = "local heuristics";
      return;
    }
    const model = await pickModel();
    if (!model) {
      // Unknown rather than absent: say nothing until a model appears.
      view.description = undefined;
      return;
    }
    const effort = cfg.get<string>("reasoningEffort", "default");
    view.description = `${modelDisplay(model)}${effort !== "default" ? ` · ${effort}` : ""}`;
  };

  void refreshViewDescription();

  // A status bar entry is the one place a tooltip can be built at runtime, so
  // it carries the detail the toolbar button cannot.
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    90
  );
  status.command = "parcelcontext.selectModel";
  context.subscriptions.push(status);

  const refreshStatus = async () => {
    const cfg = vscode.workspace.getConfiguration("parcelcontext.scan");
    const effort = cfg.get<string>("reasoningEffort", "default");
    const model = cfg.get<boolean>("useModel", true) ? await pickModel() : undefined;

    status.text = `$(sparkle) ${model ? modelDisplay(model) : "Heuristics"}`;

    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown("**ParcelContext scanning model**\n\n");
    if (model) {
      md.appendMarkdown(`| | |\n|---|---|\n`);
      md.appendMarkdown(`| Model | ${modelDisplay(model)} |\n`);
      md.appendMarkdown(`| Context | ${formatContext(model.maxInputTokens)} |\n`);
      md.appendMarkdown(`| Effort | ${effort} |\n`);
      md.appendMarkdown(
        `| Chosen | ${cfg.get<string>("model", "") ? "pinned" : "automatic"} |\n`
      );
      md.appendMarkdown(`| Id | \`${model.id}\` |\n\n`);
    } else if (cfg.get<boolean>("useModel", true)) {
      md.appendMarkdown("No model available yet. Naming falls back to local heuristics.\n\n");
    } else {
      md.appendMarkdown("Models are turned off. Naming uses local heuristics.\n\n");
    }
    md.appendMarkdown("$(edit) Click to change model or reasoning effort");
    status.tooltip = md;
  };

  const syncModelUi = async () => {
    await refreshViewDescription();
    await refreshStatus();
  };
  void syncModelUi();

  context.subscriptions.push(
    vscode.lm.onDidChangeChatModels(() => void syncModelUi()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("parcelcontext.scan")) void syncModelUi();
    }),
    view.onDidChangeVisibility((e) => {
      if (e.visible) {
        status.show();
        void syncModelUi();
      } else {
        status.hide();
      }
    })
  );
  if (view.visible) status.show();

  // Drift only ever produces an offer, never an automatic re-draft.
  let nudged = false;
  freshness.onDidChange(async () => {
    if (nudged) return;
    const enabled = await store.enabledPacks();
    const stale = enabled.filter((p) => freshness.isStale(p));
    if (stale.length === 0) return;
    nudged = true;
    const refresh = "Refresh now";
    const choice = await vscode.window.showInformationMessage(
      `"${stale[0].name}" was reviewed before ${freshness.changesSinceReview()} changes in this workspace. Refresh it?`,
      refresh,
      "Not now"
    );
    if (choice === refresh) {
      await vscode.commands.executeCommand("parcelcontext.refreshPack", undefined, stale[0].id);
    }
    nudged = false;
  });

  // Make enabled packs retrievable by Copilot.
  context.subscriptions.push(
    vscode.lm.registerTool("parcelcontext_getContext", new ContextPackTool(store))
  );

  const reg = (id: string, fn: (...a: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // ---------- search within packs ----------
  reg("parcelcontext.searchPacks", async () => {
    const packs = await store.list();
    if (packs.length === 0) {
      vscode.window.showInformationMessage(
        "There are no packs to search yet. Scan your chat history to build some."
      );
      return;
    }

    const qp = vscode.window.createQuickPick<
      vscode.QuickPickItem & { hit?: PackHit }
    >();
    qp.title = `Search ${packs.length} packs`;
    qp.placeholder = "Type to search pack names and section contents";
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;

    // Ranking happens here rather than in the widget, so a section hit can be
    // shown under the pack it belongs to.
    const render = (query: string) => {
      const hits = searchPacks(packs, query);
      qp.items = hits.slice(0, 200).map((h) => ({
        label: h.section
          ? `$(symbol-string) ${h.section.title}`
          : `$(package) ${h.pack.name}`,
        description: h.section ? `${kindLabel(h.section.kind)} · ${h.pack.name}` : "",
        detail: h.snippet,
        hit: h,
      }));
      qp.title = query
        ? `${hits.length} matches in ${packs.length} packs`
        : `Search ${packs.length} packs`;
    };

    render("");
    qp.onDidChangeValue(render);
    qp.onDidAccept(async () => {
      const picked = qp.selectedItems[0];
      qp.hide();
      qp.dispose();
      if (picked?.hit) await showPack(store, picked.hit.pack.id);
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  });

  // ---------- one entry point for creating packs ----------
  reg("parcelcontext.newPack", async () => {
    const actions = [
      {
        label: "$(search) Scan for packs",
        detail: "Group everything in your chat history into topics, then pick which to keep",
        command: "parcelcontext.scanPacks",
      },
      {
        label: "$(lightbulb) Build a pack from a topic",
        detail: "Describe a subject and collect only the exchanges about it",
        command: "parcelcontext.buildPackFromTopic",
      },
      {
        label: "$(folder) Save from this workspace",
        detail: "Draft a pack from this workspace's docs and commit history",
        command: "parcelcontext.savePack",
      },
      {
        label: "$(cloud-download) Import a pack",
        detail: "Load a .ctxpack a teammate shared with you",
        command: "parcelcontext.importPack",
      },
    ];
    const chosen = await vscode.window.showQuickPick(actions, {
      title: "Create a context pack",
      matchOnDetail: true,
    });
    if (chosen) await vscode.commands.executeCommand(chosen.command);
  });

  // ---------- build a pack for one stated topic ----------
  reg("parcelcontext.buildPackFromTopic", async () => {
    const topic = await vscode.window.showInputBox({
      title: "Build a pack from a topic",
      prompt: "What is the pack about? Describe it the way you would to a teammate.",
      placeHolder: "kusto queries for storage latency investigations",
      validateInput: (v) =>
        v.trim().length < 3 ? "Describe the topic in a few words." : undefined,
    });
    if (!topic) return;

    const scope = await chooseScope(output, "Search which workspace for this topic?");
    if (!scope) return;

    const found = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `ParcelContext: looking for "${topic}"`,
        cancellable: true,
      },
      async (progress, token) => {
        const { turns } = scanSessions(
          (done, total) => {
            if (token.isCancellationRequested) return;
            progress.report({ message: `Reading session ${done} of ${total}…` });
          },
          (msg) => output.appendLine(`[topic] ${msg}`),
          scope.uri === ALL_SCOPE ? {} : { onlyWorkspaceUri: scope.uri }
        );
        if (token.isCancellationRequested) return undefined;
        return selectForTopic(turns, topic);
      }
    );
    if (!found) return;

    output.appendLine(
      `[topic] "${topic}" matched ${found.turns.length} of ${found.scanned} exchanges (best ${found.best.toFixed(2)})`
    );
    if (found.turns.length === 0) {
      vscode.window.showWarningMessage(
        `Nothing in that chat history matched "${topic}". Try broader wording, or a wider scope.`
      );
      return;
    }

    const cluster: Cluster = {
      label: topic,
      turns: found.turns.slice(0, 120),
      terms: topTerms(
        found.turns.map((t) => t.prompt + " " + t.response).join(" "),
        8
      ),
    };

    const model = await pickModel();
    let sections = synthesiseSections(cluster);
    let modelFailed = false;
    const built = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: model
          ? `ParcelContext: building the pack with ${modelDisplay(model)}`
          : "ParcelContext: building the pack",
        cancellable: true,
      },
      async (_p, token) => {
        if (!model) return sections;
        const better = await refineSections(model, cluster, sections, token, (m) =>
          output.appendLine(`[topic] ${m}`)
        );
        if (!better) {
          modelFailed = true;
          return sections;
        }
        return better;
      }
    );
    sections = built;

    // Without this the user reviews cue-matched fragments -- "instead of one
    // Bash task per", "always requeue also produce a transcipt" -- believing
    // they are written sections, and saves a pack that reads as nonsense.
    if (modelFailed) {
      const anyway = "Review anyway";
      const choice = await vscode.window.showWarningMessage(
        `${modelDisplay(model!)} could not write this pack, so it holds raw extracted fragments rather than written sections. See the ParcelContext output for the reason.`,
        anyway,
        "Cancel"
      );
      if (choice !== anyway) return;
    }

    const picked = await reviewSections(
      sections,
      `Review the pack for "${topic}" — untick anything that should stay private`
    );
    if (!picked) return;

    const pack = newPack({
      name: topic.trim(),
      description: `Built from ${found.turns.length} exchanges about this topic.`,
      source:
        scope.uri === ALL_SCOPE ? "local chat history" : workspaceLabel(scope.uri),
      sections: picked,
    });
    await store.save(pack);
    await freshness.markReviewed();
    await vscode.commands.executeCommand("parcelcontext.library.focus");

    const enable = "Enable here";
    const choice = await vscode.window.showInformationMessage(
      `Created "${pack.name}" with ${picked.length} sections.`,
      enable,
      "Not now"
    );
    if (choice === enable) await store.setEnabled(pack.id, true);
  });

  reg("parcelcontext.refresh", () => store.refresh());

  reg("parcelcontext.showVersion", async () => {
    const packs = await store.list();
    const model = await pickModel();
    const cfg = vscode.workspace.getConfiguration("parcelcontext.scan");
    output.appendLine("--- diagnostics ---");
    output.appendLine(`version:     ${version}`);
    output.appendLine(`path:        ${context.extensionPath}`);
    output.appendLine(`host:        ${vscode.env.remoteName ?? "local"}`);
    output.appendLine(`packs:       ${packs.length}`);
    output.appendLine(`storage:     ${context.globalStorageUri.fsPath}`);
    output.appendLine(`use model:   ${cfg.get("useModel", true)}`);
    output.appendLine(`model set:   ${cfg.get<string>("model", "") || "(automatic)"}`);
    output.appendLine(`model now:   ${model ? `${modelDisplay(model)} — ${modelDetail(model)}` : "none, using heuristics"}`);
    output.appendLine(`effort:      ${cfg.get("reasoningEffort", "default")}`);

    const all = await listModels();
    output.appendLine(`available:   ${all.length}`);
    for (const m of all) {
      const mark = model && m.id === model.id ? "*" : " ";
      output.appendLine(
        `  ${mark} name=${JSON.stringify(m.name)} family=${JSON.stringify(m.family)} version=${JSON.stringify(m.version)} id=${JSON.stringify(m.id)}`
      );
    }
    output.show();
    vscode.window.showInformationMessage(
      `ParcelContext ${version} · ${packs.length} packs · ${model ? modelDisplay(model) : "heuristics"}`
    );
  });

  // ---------- scan local chat sessions ----------
  reg("parcelcontext.scanPacks", async () => {
    output.clear();
    output.appendLine(`[scan] started ${new Date().toISOString()}`);
    if (vscode.env.remoteName) {
      output.appendLine(`[scan] remote context: ${vscode.env.remoteName}`);
    }

    const scope = await chooseScope(output, "Scan chat history from which workspace?");
    if (!scope) return;

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "ParcelContext: scanning chat history",
        cancellable: true,
      },
      async (progress, token) => {
        const { turns, stats } = scanSessions(
          (done, total) => {
            if (token.isCancellationRequested) return;
            progress.report({ message: `Reading session ${done} of ${total}…` });
          },
          (msg) => output.appendLine(`[scan] ${msg}`),
          scope.uri === ALL_SCOPE ? {} : { onlyWorkspaceUri: scope.uri }
        );
        if (token.isCancellationRequested) return undefined;
        if (turns.length === 0) return { clusters: [], stats };
        progress.report({ message: "Grouping by topic…" });
        return { clusters: clusterTurns(turns), stats };
      }
    );
    if (!result) return;

    const { clusters, stats } = result;
    if (clusters.length === 0) {
      const details = "Show details";
      const choice = await vscode.window.showWarningMessage(
        stats.sessionsSeen === 0
          ? "No chat sessions were readable for that scope. Open the details to see which locations were probed."
          : `Found ${stats.sessionsSeen} sessions but nothing worth packaging. ${stats.sessionsSkipped} were skipped.`,
        details
      );
      if (choice === details) output.show();
      return;
    }

    // A model reads what the topic was about; the heuristic can only echo what
    // was typed. Naming is one request for the whole list, so it stays quick.
    const model = await pickModel();
    let naming: Map<number, ClusterNaming> | undefined;
    if (model) {
      output.appendLine(`[scan] naming with ${modelDisplay(model)} (${model.id})`);
      naming = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `ParcelContext: naming ${clusters.length} topics with ${modelDisplay(model)}`,
          cancellable: true,
        },
        (_p, token) => nameClusters(model, clusters, token)
      );
      if (!naming) output.appendLine("[scan] naming unavailable, using local labels");
    } else {
      output.appendLine("[scan] no model available, using local labels");
    }

    // Re-scanning should keep a topic's pack current, not clone it.
    const existing = await store.list();
    const byId = new Map(existing.map((p) => [p.id, p]));

    const picks = await pickMany(
      clusters.map((c, i) => {
        const id = clusterId(c);
        const prior = byId.get(id);
        const named = naming?.get(i);
        return {
          label: named?.name ?? c.label,
          description: `${c.turns.length} exchanges${prior ? " · updates existing" : ""}`,
          detail: named?.description || c.terms.join(" · "),
          cluster: c,
          id,
          prior,
          named,
        };
      }),
      {
        title: `${clusters.length} topics — ${stats.turnsExcluded} exchanges auto-excluded, ${stats.valuesMasked} values masked`,
      }
    );
    if (!picks?.length) return;

    let created = 0;
    let updated = 0;
    let refined = 0;
    let unrefined = 0;
    const touched: ContextPack[] = [];

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "ParcelContext: building packs",
        cancellable: true,
      },
      async (progress, token) => {
        for (const [n, p] of picks.entries()) {
          if (token.isCancellationRequested) break;
          progress.report({
            message: `${p.label} (${n + 1} of ${picks.length})`,
            increment: 100 / picks.length,
          });

          let sections = synthesiseSections(p.cluster);
          if (sections.length === 0) continue;

          // Refine only what the user kept, so the costly pass is never spent
          // on topics that were about to be discarded.
          if (model) {
            const better = await refineSections(model, p.cluster, sections, token, (m) =>
              output.appendLine(`[scan] ${p.label}: ${m}`)
            );
            if (better) {
              sections = better;
              refined++;
            } else {
              unrefined++;
            }
          }

          let pack: ContextPack;
          if (p.prior) {
            pack = {
              ...p.prior,
              name: p.label,
              sections: mergeSections([p.prior.sections, sections]),
              reviewedAt: new Date().toISOString(),
            };
            updated++;
          } else {
            pack = newPack({
              id: p.id,
              name: p.label,
              description:
                p.named?.description ||
                `Scanned from ${p.cluster.turns.length} chat exchanges.`,
              source: scope.uri === ALL_SCOPE ? "local chat history" : workspaceLabel(scope.uri),
              sections,
            });
            created++;
          }
          await store.save(pack);
          touched.push(pack);
        }
      }
    );

    await freshness.markReviewed();
    output.appendLine(
      `[scan] created ${created}, updated ${updated}, refined ${refined}, unrefined ${unrefined}`
    );
    await vscode.commands.executeCommand("parcelcontext.library.focus");

    if (unrefined > 0) {
      vscode.window.showWarningMessage(
        `${unrefined} pack${unrefined === 1 ? "" : "s"} could not be written by ${
          model ? modelDisplay(model) : "the model"
        } and hold raw extracted fragments. See the ParcelContext output for the reason.`
      );
    }

    const enableAll = "Enable all here";
    const choice = await vscode.window.showInformationMessage(
      `${created} new, ${updated} updated${refined ? `, ${refined} refined by ${model ? modelDisplay(model) : ""}` : ""}. Packs are saved but not yet visible to Copilot here.`,
      enableAll,
      "Not now"
    );
    if (choice === enableAll) {
      for (const p of touched) await store.setEnabled(p.id, true);
      vscode.window.showInformationMessage(
        `${touched.length} packs enabled. Reference them in chat with #contextPacks.`
      );
    }
  });

  // ---------- model selection ----------
  reg("parcelcontext.selectModel", async () => {
    const models = await listModels();
    if (models.length === 0) {
      vscode.window.showWarningMessage(
        "No language models are available. ParcelContext will use local heuristics."
      );
      return;
    }

    const cfg = vscode.workspace.getConfiguration("parcelcontext.scan");
    const target = vscode.ConfigurationTarget.Global;
    const labels = uniqueLabels(models);

    type Row = vscode.QuickPickItem & {
      id?: string;
      off?: boolean;
      effort?: boolean;
    };

    const build = (): Row[] => {
      const pinned = cfg.get<string>("model", "").trim();
      const useModel = cfg.get<boolean>("useModel", true);
      const effort = cfg.get<string>("reasoningEffort", "default");
      const gear: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon("gear"),
        tooltip: "Set reasoning effort",
      };

      return [
        {
          label: "$(sparkle) Automatic",
          description: useModel && !pinned ? "$(check) current" : "",
          detail: "Prefer MAI, then the fastest model available",
          id: "",
        },
        { label: "Models", kind: vscode.QuickPickItemKind.Separator },
        ...models.map((m) => ({
          label: labels.get(m.id) ?? modelDisplay(m),
          description: `${formatContext(m.maxInputTokens)}${
            useModel && m.id === pinned ? "  $(check) current" : ""
          }`,
          detail: modelDetail(m),
          id: m.id,
          buttons: [gear],
        })),
        { label: "Reasoning", kind: vscode.QuickPickItemKind.Separator },
        {
          label: `$(settings-gear) Reasoning effort: ${effort}`,
          detail: "Applies to whichever model is in use. Unsupported models ignore it.",
          effort: true,
        },
        { label: "", kind: vscode.QuickPickItemKind.Separator },
        {
          label: "$(circle-slash) Do not use a model",
          description: !useModel ? "$(check) current" : "",
          detail: "Name topics and extract sections with local heuristics only",
          off: true,
        },
      ];
    };

    const chooseEffort = async (): Promise<boolean> => {
      const now = cfg.get<string>("reasoningEffort", "default");
      const options = [
        { label: "Default", detail: "Let the model decide. Fastest, and right for most scans.", value: "default" },
        { label: "Low", detail: "Minimal reasoning. Quickest naming, weakest rewriting.", value: "low" },
        { label: "Medium", detail: "Balanced. Useful when topics overlap heavily.", value: "medium" },
        { label: "High", detail: "Most thorough deduplication. Noticeably slower.", value: "high" },
      ].map((e) => ({ ...e, description: e.value === now ? "$(check) current" : "" }));

      const picked = await vscode.window.showQuickPick(options, {
        title: "Reasoning effort for scanning",
        placeHolder: "Models that do not support this will ignore it",
      });
      if (!picked) return false;
      await cfg.update("reasoningEffort", picked.value, target);
      return true;
    };

    const qp = vscode.window.createQuickPick<Row>();
    qp.title = "Model for scanning chat history";
    qp.placeholder = "Pick a model, or open the gear on a row to set reasoning effort";
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.items = build();

    qp.onDidTriggerItemButton(async () => {
      qp.hide();
      if (await chooseEffort()) await syncModelUi();
      await vscode.commands.executeCommand("parcelcontext.selectModel");
    });

    qp.onDidAccept(async () => {
      const picked = qp.selectedItems[0];
      qp.hide();
      qp.dispose();
      if (!picked) return;

      if (picked.effort) {
        if (await chooseEffort()) await syncModelUi();
        return;
      }
      if (picked.off) {
        await cfg.update("useModel", false, target);
        await syncModelUi();
        vscode.window.showInformationMessage("ParcelContext will use local heuristics.");
        return;
      }

      await cfg.update("useModel", true, target);
      await cfg.update("model", picked.id ?? "", target);
      await syncModelUi();

      const now = await pickModel();
      const effort = cfg.get<string>("reasoningEffort", "default");
      vscode.window.showInformationMessage(
        now
          ? `Scanning with ${modelDisplay(now)} · ${formatContext(now.maxInputTokens)}` +
              `${effort !== "default" ? ` · ${effort} effort` : ""}.`
          : "Scanning with local heuristics."
      );
    });

    qp.onDidHide(() => qp.dispose());
    qp.show();
  });

  // ---------- split ----------
  reg("parcelcontext.splitPack", async (item?: PackTreeItem) => {
    const pack = item?.pack ?? (await pickPack(store, "Split which pack?"));
    if (!pack) return;
    if (pack.sections.length < 2) {
      vscode.window.showWarningMessage("A pack needs at least two sections to split.");
      return;
    }

    const chosen = await pickMany(
      pack.sections.map((s) => ({
        label: `${kindLabel(s.kind)}: ${s.title}`,
        detail: truncate(s.content, 120),
        section: s,
      })),
      { title: "Move these sections into a new pack", preselect: () => false }
    );
    if (!chosen?.length) return;
    if (chosen.length === pack.sections.length) {
      vscode.window.showWarningMessage("That would move everything — nothing to split.");
      return;
    }

    const name = await vscode.window.showInputBox({
      title: "Name the new pack",
      value: `${pack.name} (split)`,
      validateInput: (v) => (v.trim() ? undefined : "A name is required."),
    });
    if (!name) return;

    const { kept, moved } = splitSections(
      pack.sections,
      new Set(chosen.map((c) => c.section.id))
    );
    await store.save({ ...pack, sections: kept, reviewedAt: new Date().toISOString() });
    await store.save(
      newPack({
        name: name.trim(),
        description: pack.description,
        source: pack.source,
        sections: moved,
      })
    );
    vscode.window.showInformationMessage(
      `Split into "${pack.name}" (${kept.length}) and "${name.trim()}" (${moved.length}).`
    );
  });

  // ---------- merge ----------
  reg("parcelcontext.mergePacks", async () => {
    const all = await store.list();
    if (all.length < 2) {
      vscode.window.showWarningMessage("You need at least two packs to merge.");
      return;
    }
    const chosen = await pickMany(
      all.map((p) => ({
        label: p.name,
        description: `${p.sections.length} sections`,
        detail: p.description,
        pack: p,
      })),
      { title: "Merge which packs?", preselect: () => false }
    );
    if (!chosen || chosen.length < 2) return;

    const name = await vscode.window.showInputBox({
      title: "Name the merged pack",
      value: chosen[0].pack.name,
      validateInput: (v) => (v.trim() ? undefined : "A name is required."),
    });
    if (!name) return;

    const sections = mergeSections(chosen.map((c) => c.pack.sections));
    const dropped =
      chosen.reduce((n, c) => n + c.pack.sections.length, 0) - sections.length;

    const merged = newPack({
      name: name.trim(),
      description: `Merged from ${chosen.map((c) => c.pack.name).join(", ")}.`,
      source: chosen[0].pack.source,
      sections,
    });
    await store.save(merged);

    const removeOriginals = await vscode.window.showInformationMessage(
      `Created "${merged.name}" with ${sections.length} sections${
        dropped > 0 ? ` (${dropped} duplicates dropped)` : ""
      }. Remove the originals?`,
      "Keep originals",
      "Remove originals"
    );
    if (removeOriginals === "Remove originals") {
      for (const c of chosen) await store.delete(c.pack.id);
    }
  });

  // ---------- save ----------
  reg("parcelcontext.savePack", async () => {
    const name = await vscode.window.showInputBox({
      title: "Save context pack",
      prompt: "Name this pack — something a teammate would recognise",
      placeHolder: "Project Handoff",
      validateInput: (v) => (v.trim() ? undefined : "A name is required."),
    });
    if (!name) return;

    const description =
      (await vscode.window.showInputBox({
        title: "Save context pack",
        prompt: "One line on what this pack is for (optional)",
        placeHolder: "Background needed to pick up the checkout migration",
      })) ?? "";

    const drafted = await autoDraftSections();
    if (!drafted) return;

    // Review step: nothing is saved until the user picks what to include.
    const picked = await reviewSections(drafted);
    if (!picked) return;

    const pack = newPack({
      name: name.trim(),
      description: description.trim(),
      source: workspaceName(),
      sections: picked,
    });
    await store.save(pack);

    const enable = "Enable here";
    const choice = await vscode.window.showInformationMessage(
      `Saved "${pack.name}" with ${pack.sections.length} sections.`,
      enable,
      "Export"
    );
    if (choice === enable) await store.setEnabled(pack.id, true);
    if (choice === "Export") await exportPack(store, pack);
    await freshness.markReviewed();
  });

  // ---------- refresh an existing pack from the workspace ----------
  reg("parcelcontext.refreshPack", async (item?: PackTreeItem, packId?: string) => {
    const pack =
      item?.pack ??
      (packId ? await store.get(packId) : undefined) ??
      (await pickPack(store, "Refresh which pack?"));
    if (!pack) return;

    const drafted = await autoDraftSections();
    if (!drafted) return;

    // Existing sections are offered alongside the new draft, pre-ticked, so a
    // refresh never silently drops knowledge the user already reviewed.
    const merged = [...pack.sections, ...drafted];
    const picked = await reviewSections(merged, "Refresh — new findings are at the bottom");
    if (!picked) return;

    await store.save({
      ...pack,
      sections: picked,
      reviewedAt: new Date().toISOString(),
    });
    await freshness.markReviewed();
    vscode.window.showInformationMessage(
      `Refreshed "${pack.name}" — ${picked.length} sections reviewed.`
    );
  });

  // ---------- list ----------
  reg("parcelcontext.listPacks", async () => {
    const pack = await pickPack(store, "Context packs in your library");
    if (pack) await showPack(store, pack.id);
  });

  reg("parcelcontext.showPack", async (id?: string) => {
    const packId = id ?? (await pickPack(store, "Show pack details"))?.id;
    if (packId) await showPack(store, packId);
  });

  // ---------- export ----------
  reg("parcelcontext.exportPack", async (item?: PackTreeItem) => {
    const pack = item?.pack ?? (await pickPack(store, "Export which pack?"));
    if (pack) await exportPack(store, pack);
  });

  reg("parcelcontext.sharePack", async (item?: PackTreeItem) => {
    const pack = item?.pack ?? (await pickPack(store, "Share which pack?"));
    if (!pack) return;
    const target = await exportPack(store, pack);
    if (!target) return;
    await vscode.env.clipboard.writeText(target.fsPath);
    vscode.window.showInformationMessage(
      `Exported "${pack.name}" and copied its path. Share it through a channel your team already uses — exporting grants no access to any system, and a shared file cannot be recalled.`
    );
  });

  // ---------- import ----------
  reg("parcelcontext.importPack", async () => {
    const picked = await vscode.window.showOpenDialog({
      title: "Import context pack",
      canSelectMany: false,
      filters: { "Context pack": [PACK_EXTENSION], "All files": ["*"] },
    });
    if (!picked?.length) return;

    let incoming: ContextPack;
    try {
      incoming = await store.readForReview(picked[0]);
    } catch (err) {
      vscode.window.showErrorMessage(
        `That file isn't a valid context pack: ${(err as Error).message}`
      );
      return;
    }

    // Always preview before anything lands in the library.
    await showPackPreview(incoming);
    const proceed = await vscode.window.showInformationMessage(
      `Import "${incoming.name}" with ${incoming.sections.length} sections?`,
      { modal: true },
      "Import",
      "Import and enable here"
    );
    if (!proceed) return;

    const existing = await store.get(incoming.id);
    if (existing) {
      const resolved = await resolveConflict(existing, incoming);
      if (!resolved) return;
      incoming = resolved;
    }

    await store.save(incoming);
    if (proceed === "Import and enable here") {
      await store.setEnabled(incoming.id, true);
    }
    vscode.window.showInformationMessage(`Imported "${incoming.name}".`);
  });

  // ---------- enable ----------
  reg("parcelcontext.toggleForWorkspace", async (item?: PackTreeItem) => {
    const pack = item?.pack ?? (await pickPack(store, "Enable or disable which pack?"));
    if (!pack) return;
    const next = !store.isEnabled(pack.id);
    await store.setEnabled(pack.id, next);
    vscode.window.showInformationMessage(
      next
        ? `"${pack.name}" is now available to Copilot in this workspace.`
        : `"${pack.name}" is no longer used in this workspace.`
    );
  });

  // ---------- delete ----------
  reg("parcelcontext.deletePack", async (item?: PackTreeItem) => {
    // From the tree, delete the clicked pack. From the palette, allow a sweep --
    // a scan can produce dozens of packs and removing them one at a time is grim.
    if (item?.pack) {
      const ok = await vscode.window.showWarningMessage(
        `Delete "${item.pack.name}" from your library?`,
        { modal: true },
        "Delete"
      );
      if (ok === "Delete") await store.delete(item.pack.id);
      return;
    }

    const all = await store.list();
    if (all.length === 0) {
      vscode.window.showInformationMessage("There are no packs to delete.");
      return;
    }
    const chosen = await pickMany(
      all.map((p) => ({
        label: p.name,
        description: `${p.sections.length} sections${store.isEnabled(p.id) ? " · enabled here" : ""}`,
        detail: `${p.source} · reviewed ${p.reviewedAt.slice(0, 10)}`,
        pack: p,
      })),
      { title: "Delete which packs?", preselect: () => false }
    );
    if (!chosen?.length) return;

    const ok = await vscode.window.showWarningMessage(
      chosen.length === 1
        ? `Delete "${chosen[0].pack.name}"?`
        : `Delete ${chosen.length} packs? This cannot be undone.`,
      { modal: true },
      "Delete"
    );
    if (ok !== "Delete") return;
    for (const c of chosen) await store.delete(c.pack.id);
    vscode.window.showInformationMessage(`Deleted ${chosen.length} packs.`);
  });
}

export function deactivate() {}

// ============================ helpers ============================

function workspaceName(): string {
  const f = vscode.workspace.workspaceFolders?.[0];
  return f ? f.name : "untitled workspace";
}

/** The current workspace as a decoded URI, matching what the scan reports. */
function currentWorkspaceUri(): string | undefined {
  const f = vscode.workspace.workspaceFolders?.[0];
  return f ? decodeURIComponent(f.uri.toString()) : undefined;
}

async function pickPack(
  store: PackStore,
  title: string
): Promise<ContextPack | undefined> {
  const packs = await store.list();
  if (packs.length === 0) {
    vscode.window.showInformationMessage(
      "No context packs yet. Run “ParcelContext: Save Context Pack” to create one."
    );
    return undefined;
  }
  const items = packs.map((p) => ({
    label: p.name,
    description: store.isEnabled(p.id) ? "enabled here" : "",
    detail: `${p.sections.length} sections · ${p.source} · reviewed ${p.reviewedAt.slice(0, 10)}`,
    pack: p,
  }));
  const chosen = await vscode.window.showQuickPick(items, {
    title,
    matchOnDetail: true,
  });
  return chosen?.pack;
}

/**
 * Builds candidate sections from the workspace itself: docs, commit history,
 * changed files, and anything the user has selected. The user types nothing.
 *
 * This is the honest boundary of the MVP — there is no access to prior chat
 * history or hidden model state, so the evidence is what is on disk and in git.
 */
async function autoDraftSections(): Promise<PackSection[] | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage("Open a folder first — a pack is drafted from a workspace.");
    return undefined;
  }

  const sections = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "ParcelContext",
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ message: "Reading workspace evidence…" });
      const signals = await collectSignals(folder);

      if (signalsAreThin(signals)) {
        vscode.window.showWarningMessage(
          "No docs or commit history found in this workspace, so there is nothing to draft from."
        );
        return undefined;
      }

      progress.report({ message: "Drafting context pack…" });
      const modelDraft = await draftWithModel(signals, token);
      if (token.isCancellationRequested) return undefined;

      const drafted = modelDraft ?? draftHeuristically(signals);
      return { drafted, signals };
    }
  );

  if (!sections) return undefined;
  const { drafted, signals } = sections;

  // Anything the user has actively selected is worth offering too.
  const editor = vscode.window.activeTextEditor;
  if (editor && !editor.selection.isEmpty) {
    const text = editor.document.getText(editor.selection).trim();
    if (text) {
      drafted.push({
        id: cryptoRandomId(),
        kind: "reference",
        title: `Selection from ${shortName(editor.document.uri)}`,
        content: truncate(text, 2000),
      });
    }
  }

  const evidence = `${signals.docs.length} docs · ${signals.commits.length} commits · ${signals.changedFiles.length} changed files`;
  return reviewSections(drafted, `Drafted from ${evidence} — untick anything that should stay private`);
}

/** The review gate. Everything is opt-in; deselected content never leaves. */
async function reviewSections(
  drafted: PackSection[],
  title = "Review what goes in — untick anything that should stay private"
): Promise<PackSection[] | undefined> {
  const chosen = await pickMany(
    drafted.map((s) => ({
      label: `${kindLabel(s.kind)}: ${s.title}`,
      detail: truncate(s.content, 120),
      section: s,
    })),
    { title }
  );
  if (!chosen) return undefined;
  if (chosen.length === 0) {
    vscode.window.showWarningMessage("Nothing selected, so no pack was created.");
    return undefined;
  }
  return chosen.map((c) => c.section);
}

async function exportPack(
  store: PackStore,
  pack: ContextPack
): Promise<vscode.Uri | undefined> {
  const target = await vscode.window.showSaveDialog({
    title: "Export context pack",
    defaultUri: defaultExportUri(pack),
    filters: { "Context pack": [PACK_EXTENSION] },
  });
  if (!target) return undefined;
  try {
    await store.export(pack, target);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Could not write "${target.fsPath}": ${(err as Error).message}`
    );
    return undefined;
  }
  return target;
}

/**
 * A bare filename handed to Uri.file() resolves to the filesystem root, which
 * is not writable. Always anchor the suggestion somewhere the user can write.
 */
function defaultExportUri(pack: ContextPack): vscode.Uri {
  const fileName = `${slug(pack.name)}.${PACK_EXTENSION}`;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) return vscode.Uri.joinPath(folder.uri, fileName);
  return vscode.Uri.joinPath(vscode.Uri.file(os.homedir()), fileName);
}

async function showPack(store: PackStore, id: string): Promise<void> {
  const pack = await store.get(id);
  if (!pack) {
    vscode.window.showErrorMessage("That pack is no longer in your library.");
    return;
  }
  await showPackPreview(pack, store.isEnabled(pack.id));
}

async function showPackPreview(
  pack: ContextPack,
  enabled?: boolean
): Promise<void> {
  const lines: string[] = [
    `# ${pack.name}`,
    "",
    pack.description || "_No description._",
    "",
    "| | |",
    "|---|---|",
    `| Source | ${pack.source} |`,
    `| Reviewed | ${pack.reviewedAt.slice(0, 10)} |`,
    `| Sections | ${pack.sections.length} |`,
  ];
  if (enabled !== undefined) {
    lines.push(`| Enabled here | ${enabled ? "yes" : "no"} |`);
  }
  lines.push("");

  const grouped = new Map<string, PackSection[]>();
  for (const s of pack.sections) {
    const label = kindLabel(s.kind);
    grouped.set(label, [...(grouped.get(label) ?? []), s]);
  }
  for (const [label, sections] of grouped) {
    lines.push(`## ${label}`, "");
    for (const s of sections) {
      lines.push(`**${s.title}**`, "", s.content, "");
    }
  }
  lines.push(
    "---",
    "",
    "_This pack contains only content its author selected and reviewed. " +
      "It carries no chat history, no model state, and no access to any system._"
  );

  const doc = await vscode.workspace.openTextDocument({
    content: lines.join("\n"),
    language: "markdown",
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}

/** Conflicts are resolved by the user. Nothing is overwritten automatically. */
async function resolveConflict(
  existing: ContextPack,
  incoming: ContextPack
): Promise<ContextPack | undefined> {
  const choice = await vscode.window.showWarningMessage(
    `A pack with this id already exists: "${existing.name}" (reviewed ${existing.reviewedAt.slice(0, 10)}). ` +
      `Incoming is "${incoming.name}" (reviewed ${incoming.reviewedAt.slice(0, 10)}).`,
    { modal: true },
    "Keep existing",
    "Use incoming",
    "Keep both"
  );
  if (!choice || choice === "Keep existing") return undefined;
  if (choice === "Use incoming") return incoming;
  return {
    ...incoming,
    id: cryptoRandomId(),
    name: `${incoming.name} (imported)`,
  };
}

function shortName(uri: vscode.Uri): string {
  const parts = uri.path.split("/");
  return parts[parts.length - 1] || uri.path;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}



