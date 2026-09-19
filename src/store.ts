import * as vscode from "vscode";
import {
  ContextPack,
  PACK_EXTENSION,
  parsePack,
} from "./types";

const ENABLED_KEY = "parcelcontext.enabledPackIds";

/**
 * Pack library.
 *
 * Packs live in global storage so they travel between workspaces.
 * Which packs are *enabled* is per workspace, so importing a pack never
 * silently exposes it everywhere.
 */
export class PackStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  private get libraryDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.ctx.globalStorageUri, "packs");
  }

  private packUri(id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.libraryDir, `${id}.${PACK_EXTENSION}`);
  }

  async ensureDir(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.libraryDir);
  }

  async list(): Promise<ContextPack[]> {
    await this.ensureDir();
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.libraryDir);
    } catch {
      return [];
    }
    const packs: ContextPack[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File) continue;
      if (!name.endsWith(`.${PACK_EXTENSION}`)) continue;
      try {
        const uri = vscode.Uri.joinPath(this.libraryDir, name);
        packs.push(await readPackFile(uri));
      } catch {
        // A malformed file should never take down the whole library view.
      }
    }
    return packs.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<ContextPack | undefined> {
    try {
      return await readPackFile(this.packUri(id));
    } catch {
      return undefined;
    }
  }

  async save(pack: ContextPack): Promise<void> {
    await this.ensureDir();
    const body = Buffer.from(JSON.stringify(pack, null, 2), "utf8");
    await vscode.workspace.fs.writeFile(this.packUri(pack.id), body);
    this._onDidChange.fire();
  }

  async delete(id: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.packUri(id));
    } catch {
      /* already gone */
    }
    await this.setEnabled(id, false);
    this._onDidChange.fire();
  }

  async export(pack: ContextPack, target: vscode.Uri): Promise<void> {
    const body = Buffer.from(JSON.stringify(pack, null, 2), "utf8");
    await vscode.workspace.fs.writeFile(target, body);
  }

  /**
   * Imports a pack file. Returns the parsed pack *without* saving, so the
   * caller can show the contents for review first. Nothing is ever imported
   * silently.
   */
  async readForReview(source: vscode.Uri): Promise<ContextPack> {
    return readPackFile(source);
  }

  // ---- per-workspace enablement ----

  enabledIds(): string[] {
    return this.ctx.workspaceState.get<string[]>(ENABLED_KEY, []);
  }

  isEnabled(id: string): boolean {
    return this.enabledIds().includes(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const current = new Set(this.enabledIds());
    if (enabled) {
      current.add(id);
    } else {
      current.delete(id);
    }
    await this.ctx.workspaceState.update(ENABLED_KEY, [...current]);
    this._onDidChange.fire();
  }

  async enabledPacks(): Promise<ContextPack[]> {
    const ids = new Set(this.enabledIds());
    return (await this.list()).filter((p) => ids.has(p.id));
  }

  refresh(): void {
    this._onDidChange.fire();
  }
}

async function readPackFile(uri: vscode.Uri): Promise<ContextPack> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = Buffer.from(bytes).toString("utf8");
  return parsePack(JSON.parse(text));
}
