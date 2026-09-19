import * as vscode from "vscode";
import { ContextPack } from "./types";

const LAST_CHANGE_KEY = "parcelcontext.lastWorkspaceChange";
const CHANGE_COUNT_KEY = "parcelcontext.changeCountSince";

/** How many edits before an enabled pack is worth re-drafting. */
const STALE_CHANGE_THRESHOLD = 25;

const WATCH_GLOB =
  "**/*.{ts,tsx,js,jsx,py,cs,go,java,rs,md,json,yml,yaml}";

/**
 * Watches the workspace so packs can tell you when they have drifted behind the
 * code, instead of silently going stale. Nothing is re-drafted automatically --
 * drift only ever produces an offer.
 */
export class FreshnessTracker implements vscode.Disposable {
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private pending = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.watcher = vscode.workspace.createFileSystemWatcher(WATCH_GLOB);
    const bump = (uri: vscode.Uri) => this.record(uri);
    this.disposables.push(
      this.watcher.onDidChange(bump),
      this.watcher.onDidCreate(bump),
      this.watcher.onDidDelete(bump),
      this.watcher
    );
  }

  private record(uri: vscode.Uri) {
    if (uri.path.includes("/node_modules/") || uri.path.includes("/.git/")) return;
    this.pending++;
    // Debounce: a save storm or a branch switch is one event, not two hundred.
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 1500);
  }

  private async flush() {
    if (this.pending === 0) return;
    const count = this.ctx.workspaceState.get<number>(CHANGE_COUNT_KEY, 0);
    await this.ctx.workspaceState.update(CHANGE_COUNT_KEY, count + this.pending);
    await this.ctx.workspaceState.update(LAST_CHANGE_KEY, new Date().toISOString());
    this.pending = 0;
    this._onDidChange.fire();
  }

  changesSinceReview(): number {
    return this.ctx.workspaceState.get<number>(CHANGE_COUNT_KEY, 0);
  }

  lastChangeAt(): string | undefined {
    return this.ctx.workspaceState.get<string>(LAST_CHANGE_KEY);
  }

  /** A pack is stale when the workspace moved on materially after its review. */
  isStale(pack: ContextPack): boolean {
    const last = this.lastChangeAt();
    if (!last) return false;
    if (new Date(last).getTime() <= new Date(pack.reviewedAt).getTime()) return false;
    return this.changesSinceReview() >= STALE_CHANGE_THRESHOLD;
  }

  /** Called after a pack is reviewed, so drift is measured from that point. */
  async markReviewed(): Promise<void> {
    await this.ctx.workspaceState.update(CHANGE_COUNT_KEY, 0);
    this._onDidChange.fire();
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this._onDidChange.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
