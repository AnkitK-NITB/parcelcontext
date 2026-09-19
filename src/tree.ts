import * as vscode from "vscode";
import { PackStore } from "./store";
import { FreshnessTracker } from "./freshness";
import { ContextPack, kindLabel } from "./types";

export class PackTreeItem extends vscode.TreeItem {
  constructor(
    public readonly pack: ContextPack,
    enabled: boolean,
    stale: boolean
  ) {
    super(pack.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "pack";
    this.id = pack.id;

    const bits: string[] = [];
    if (enabled) bits.push("enabled");
    bits.push(`${pack.sections.length} sections`);
    if (stale) bits.push("may be stale");
    this.description = bits.join(" · ");

    this.iconPath = new vscode.ThemeIcon(
      stale ? "warning" : enabled ? "pass-filled" : "circle-large-outline"
    );
    this.tooltip = new vscode.MarkdownString(
      [
        `**${pack.name}**`,
        pack.description || "_No description_",
        "",
        `Source: \`${pack.source}\``,
        `Reviewed: ${pack.reviewedAt.slice(0, 10)}`,
        `Enabled for this workspace: **${enabled ? "yes" : "no"}**`,
        stale
          ? "\n_The workspace has moved on since this was reviewed. Refresh to re-draft it._"
          : "",
      ].join("\n\n")
    );
    this.command = {
      command: "parcelcontext.showPack",
      title: "Show pack",
      arguments: [pack.id],
    };
  }
}

class SectionTreeItem extends vscode.TreeItem {
  constructor(label: string, content: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "section";
    this.description = content.length > 60 ? content.slice(0, 60) + "…" : content;
    this.tooltip = content;
    this.iconPath = new vscode.ThemeIcon("symbol-string");
  }
}

export class PackTreeProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly store: PackStore,
    private readonly freshness: FreshnessTracker
  ) {
    store.onDidChange(() => this._onDidChangeTreeData.fire());
    freshness.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      const packs = await this.store.list();
      return packs.map(
        (p) =>
          new PackTreeItem(
            p,
            this.store.isEnabled(p.id),
            this.freshness.isStale(p)
          )
      );
    }
    if (element instanceof PackTreeItem) {
      return element.pack.sections.map(
        (s) => new SectionTreeItem(`${kindLabel(s.kind)}: ${s.title}`, s.content)
      );
    }
    return [];
  }
}
