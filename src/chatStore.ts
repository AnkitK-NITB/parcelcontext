import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ChatTurn, ScanStats, emptyStats, redact } from "./scanCore";

/**
 * VS Code has used more than one chat store. Older builds wrote one JSON file
 * per session under chatSessions; current builds write JSONL transcripts under
 * the Copilot Chat extension's own storage. Remote workspaces keep transcripts
 * on the remote side, which is why a WSL window finds nothing on the client.
 *
 * None of this is a public API, so every read is defensive and an unexpected
 * shape degrades to "found nothing" rather than throwing.
 */
const SESSION_DIRS = ["chatSessions", "emptyWindowChatSessions"];
const TRANSCRIPT_DIR = ["GitHub.copilot-chat", "transcripts"];

/** Sessions larger than this are skipped; they are almost always long agent runs. */
const MAX_SESSION_BYTES = 24 * 1024 * 1024;

const MAX_TEXT_CHARS = 6000;
const MAX_TURNS_PER_SESSION = 60;

export interface SessionFile {
  file: string;
  /** workspaceStorage folder name, used to resolve which workspace this was. */
  storageKey: string;
  format: "json" | "jsonl";
}

export function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft|wsl/i.test(fs.readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function safeExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Windows user profile directories visible from a WSL extension host. */
function windowsHomesFromWsl(): string[] {
  if (!isWsl()) return [];
  const homes: string[] = [];
  const skip = new Set(["All Users", "Default", "Default User", "Public", "defaultuser0"]);
  for (const mount of ["/mnt/c", "/mnt/d", "/mnt/e"]) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(mount, "Users"), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory() && !skip.has(e.name)) {
        homes.push(path.join(mount, "Users", e.name));
      }
    }
  }
  return homes;
}

/** Every location worth probing, whether or not it exists. Used for diagnostics. */
export function candidateRoots(): string[] {
  const home = os.homedir();
  const roots: string[] = [];
  const products = ["Code", "Code - Insiders", "Code - Exploration", "VSCodium", "Cursor"];
  const leaves = ["workspaceStorage", "globalStorage"];

  const push = (base: string, product: string) => {
    for (const leaf of leaves) roots.push(path.join(base, product, "User", leaf));
  };

  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    for (const p of products) push(appData, p);
  } else if (process.platform === "darwin") {
    const base = path.join(home, "Library", "Application Support");
    for (const p of products) push(base, p);
  } else {
    const base = path.join(home, ".config");
    for (const p of products) push(base, p);
  }

  // A remote extension host keeps its own server-side storage, and for remote
  // workspaces that is where the transcripts actually live.
  for (const server of [".vscode-server", ".vscode-server-insiders", ".cursor-server"]) {
    for (const leaf of leaves) roots.push(path.join(home, server, "data", "User", leaf));
  }

  // Under WSL the client-side store is reachable through /mnt.
  for (const winHome of windowsHomesFromWsl()) {
    const appData = path.join(winHome, "AppData", "Roaming");
    for (const p of products) push(appData, p);
  }

  return [...new Set(roots)];
}

export function storageRoots(): string[] {
  return candidateRoots().filter(safeExists);
}

let fileCache: { at: number; files: SessionFile[] } | undefined;
const CACHE_MS = 30_000;

export function findSessionFiles(log?: (msg: string) => void): SessionFile[] {
  // The scope picker and the scan that follows it enumerate the same tree
  // seconds apart, and over /mnt that walk is not cheap.
  if (fileCache && Date.now() - fileCache.at < CACHE_MS) {
    log?.(`reusing ${fileCache.files.length} session files found moments ago`);
    return fileCache.files;
  }

  const files: SessionFile[] = [];
  const roots = storageRoots();
  log?.(`platform=${process.platform} wsl=${isWsl()} home=${os.homedir()}`);
  log?.(`probed ${candidateRoots().length} candidate roots, ${roots.length} exist`);

  for (const root of roots) {
    let found = 0;
    const take = (dir: string, storageKey: string) => {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const n of names) {
        if (n.endsWith(".jsonl")) {
          files.push({ file: path.join(dir, n), storageKey, format: "jsonl" });
          found++;
        } else if (n.endsWith(".json")) {
          files.push({ file: path.join(dir, n), storageKey, format: "json" });
          found++;
        }
      }
    };

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      log?.(`  ${root} -> unreadable: ${(err as Error).message}`);
      continue;
    }

    for (const e of entries) {
      if (!e.isDirectory()) continue;
      for (const sub of SESSION_DIRS) take(path.join(root, e.name, sub), e.name);
      take(path.join(root, e.name, ...TRANSCRIPT_DIR), e.name);
    }
    // globalStorage keeps a couple of session dirs at its own top level.
    for (const sub of SESSION_DIRS) take(path.join(root, sub), "");

    log?.(`  ${root} -> ${found} session files`);
  }
  log?.(`total session files: ${files.length}`);
  fileCache = { at: Date.now(), files };
  return files;
}

/** Resolves the workspace a storage folder belongs to, on client or remote. */
export function workspaceUriFor(storageKey: string): string | undefined {
  if (!storageKey) return undefined;
  for (const root of storageRoots()) {
    try {
      const j = JSON.parse(
        fs.readFileSync(path.join(root, storageKey, "workspace.json"), "utf8")
      ) as Record<string, string>;
      const uri = j.folder ?? j.workspace;
      if (uri) return decodeURIComponent(uri);
    } catch {
      /* not in this root */
    }
  }
  return undefined;
}

/** Last path segment of a workspace URI, for display and matching. */
export function workspaceLabel(uri: string | undefined): string {
  if (!uri) return "unknown workspace";
  const clean = uri.replace(/[\\/]+$/, "");
  return clean.split(/[\\/]/).pop() || clean;
}

/**
 * The same folder is recorded under several URI forms. A WSL folder appears as
 * vscode-remote://wsl+ubuntu/..., file://wsl.localhost/Ubuntu/... or
 * \\wsl$\Ubuntu\... in stored workspace entries, while the extension host
 * running inside WSL reports it as a plain file:///home/... path. Comparing raw
 * strings both splits one workspace into several and stops the current
 * workspace from ever matching its own history.
 *
 * Keys are `kind|qualifier|path` so a missing qualifier can be tolerated.
 */
export function normalizeWorkspaceUri(uri: string, distroHint?: string): string {
  let s = uri;
  try {
    s = decodeURIComponent(s);
  } catch {
    /* already decoded */
  }
  s = s.replace(/\\/g, "/").replace(/\/+$/, "");

  const wsl = (d: string, p: string) => `wsl|${d.toLowerCase()}|${p.toLowerCase()}`;
  const win = (d: string, p: string) => `win|${d.toLowerCase()}|${p.toLowerCase()}`;

  let m: RegExpMatchArray | null;

  if ((m = s.match(/^vscode-remote:\/\/wsl\+([^/]+)(\/.*)$/i))) return wsl(m[1], m[2]);
  if ((m = s.match(/^(?:file:)?\/\/wsl[.$][^/]*\/([^/]+)(\/.*)$/i))) return wsl(m[1], m[2]);
  if ((m = s.match(/^(?:file:\/\/\/)?([a-z]):(\/.*)$/i))) return win(m[1], m[2]);

  if ((m = s.match(/^(?:file:\/\/)?(\/.+)$/))) {
    const p = m[1];
    // A Windows drive mounted into WSL is still the Windows folder.
    const mount = p.match(/^\/mnt\/([a-z])(\/.*)$/i);
    if (mount) return win(mount[1], mount[2]);

    const distro = distroHint ?? currentDistro();
    return distro === undefined ? `posix|-|${p.toLowerCase()}` : wsl(distro, p);
  }
  return s.toLowerCase();
}

/** The distro this host runs in, or undefined when not under WSL. */
function currentDistro(): string | undefined {
  if (!isWsl()) return undefined;
  return process.env.WSL_DISTRO_NAME ?? "?";
}

export function sameWorkspace(
  a: string | undefined,
  b: string | undefined,
  distroHint?: string
): boolean {
  if (!a || !b) return false;
  const ka = normalizeWorkspaceUri(a, distroHint);
  const kb = normalizeWorkspaceUri(b, distroHint);
  if (ka === kb) return true;

  // The host may not know which distro it is in. Matching on path alone is the
  // right trade there: two distros sharing a path is rare, and the cost is a
  // slightly wider scan rather than a wrong one.
  const [ta, da, pa] = ka.split("|");
  const [tb, db, pb] = kb.split("|");
  if (ta === "wsl" && tb === "wsl" && pa === pb) {
    return da === "?" || db === "?";
  }
  return false;
}

// ------------------------------------------------------------------ readers

function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object") return "";
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join("\n");
  const o = v as Record<string, unknown>;
  if (typeof o.text === "string") return o.text;
  if (typeof o.content === "string") return o.content;
  if (typeof o.value === "string") return o.value;
  if (Array.isArray(o.parts)) return o.parts.map(asText).filter(Boolean).join("\n");
  return "";
}

/**
 * Response parts carry tool traffic and progress chrome alongside the prose.
 * Those kinds hold no reusable knowledge and only dilute a pack.
 */
const RESPONSE_NOISE_KINDS = new Set([
  "mcpServersStarting",
  "prepareToolInvocation",
  "toolInvocationSerialized",
  "progressTaskSerialized",
  "progressMessage",
  "undoStop",
  "codeblockUri",
  "textEditGroup",
  "inlineReference",
  "confirmation",
]);

/**
 * A response is a list of streamed parts, so the pieces join with nothing
 * between them: the prose already carries its own newlines, and joining on one
 * breaks sentences in half.
 */
function asResponseText(v: unknown): string {
  if (!Array.isArray(v)) return asText(v);
  return v
    .filter((p) => {
      if (!p || typeof p !== "object") return true;
      const kind = (p as Record<string, unknown>).kind;
      return typeof kind !== "string" || !RESPONSE_NOISE_KINDS.has(kind);
    })
    .map(asText)
    .filter(Boolean)
    .join("");
}

interface RawTurn {
  prompt: string;
  response: string;
  modelId: string;
  timestamp: number;
}

/** Shared by every reader once a `requests` array has been materialised. */
function turnsFromRequests(requests: unknown[]): RawTurn[] {
  const turns: RawTurn[] = [];
  for (const r of requests.slice(0, MAX_TURNS_PER_SESSION)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    turns.push({
      prompt: asText(o.message).slice(0, MAX_TEXT_CHARS),
      response: asResponseText(o.response).slice(0, MAX_TEXT_CHARS),
      modelId: String(o.modelId ?? ""),
      timestamp: Number(o.timestamp ?? 0),
    });
  }
  return turns;
}

/** Older per-session JSON: { requests: [{ message, response, modelId }] }. */
function readJsonSession(text: string): { title: string; turns: RawTurn[] } | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const requests = parsed.requests;
  if (!Array.isArray(requests)) return undefined;

  return {
    title: String(parsed.customTitle ?? ""),
    turns: turnsFromRequests(requests),
  };
}

/**
 * Walks to the container holding the last key, creating anything missing on the
 * way. The next key decides the shape: a number means an array.
 */
function containerFor(
  root: Record<string, unknown>,
  keys: (string | number)[]
): Record<string, unknown> | unknown[] | undefined {
  let cur: unknown = root;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur === null || typeof cur !== "object") return undefined;
    const holder = cur as Record<string | number, unknown>;
    if (holder[keys[i]] === undefined || holder[keys[i]] === null) {
      holder[keys[i]] = typeof keys[i + 1] === "number" ? [] : {};
    }
    cur = holder[keys[i]];
  }
  return cur === null || typeof cur !== "object"
    ? undefined
    : (cur as Record<string, unknown> | unknown[]);
}

/**
 * Current VS Code sessions: an incremental journal rather than a transcript.
 * Each line is {kind, k, v} -- kind 0 is the opening state, kind 1 sets the
 * value at path k, kind 2 appends to the array at path k.
 *
 * Replaying matters, because an agent turn is written in two stages: the
 * request is appended first, carrying only the model's opening line, and the
 * answer itself arrives later as an append to requests[n].response. Reading
 * just the first write keeps "I'll read that README" and throws away every
 * command the answer contained.
 */
function readJournalSession(text: string): { title: string; turns: RawTurn[] } | undefined {
  let state: Record<string, unknown> | undefined;
  let applied = 0;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let ev: { kind?: unknown; k?: unknown; v?: unknown };
    try {
      ev = JSON.parse(trimmed) as { kind?: unknown; k?: unknown; v?: unknown };
    } catch {
      continue;
    }
    if (!ev || typeof ev !== "object" || typeof ev.kind !== "number") continue;

    if (ev.kind === 0) {
      if (ev.v && typeof ev.v === "object" && !Array.isArray(ev.v)) {
        state = ev.v as Record<string, unknown>;
        applied++;
      }
      continue;
    }

    const keys = Array.isArray(ev.k) ? (ev.k as (string | number)[]) : [];
    if (keys.length === 0) continue;
    if (!state) state = {};

    const parent = containerFor(state, keys);
    if (!parent) continue;
    const last = keys[keys.length - 1];
    const holder = parent as Record<string | number, unknown>;

    if (ev.kind === 1) {
      holder[last] = ev.v;
      applied++;
    } else if (ev.kind === 2) {
      const additions = Array.isArray(ev.v) ? ev.v : [ev.v];
      const target = holder[last];
      if (Array.isArray(target)) target.push(...additions);
      else holder[last] = additions;
      applied++;
    }
  }

  if (!state || applied === 0 || !Array.isArray(state.requests)) return undefined;
  const turns = turnsFromRequests(state.requests);
  if (turns.length === 0) return undefined;
  return { title: String(state.customTitle ?? ""), turns };
}

/**
 * Picks a reader by what the file actually contains. The extension only hints:
 * the journal format is written to .jsonl files that are not transcripts, and
 * a misread costs the whole session.
 */
export function readSession(
  text: string,
  format: "json" | "jsonl"
): { title: string; turns: RawTurn[] } | undefined {
  const journal = readJournalSession(text);
  if (journal) return journal;

  const ordered =
    format === "jsonl"
      ? [() => readJsonlTranscript(text), () => readJsonSession(text)]
      : [() => readJsonSession(text), () => readJsonlTranscript(text)];

  for (const read of ordered) {
    const parsed = read();
    if (parsed && parsed.turns.length > 0) return parsed;
  }
  return undefined;
}

/**
 * Current JSONL transcripts: one event per line. User and assistant messages
 * are interleaved with tool traffic, which is noise for our purposes.
 */
function readJsonlTranscript(text: string): { title: string; turns: RawTurn[] } {
  const turns: RawTurn[] = [];
  let pendingPrompt = "";
  let pendingResponse: string[] = [];
  let modelId = "";
  let title = "";

  const flush = (ts: number) => {
    if (!pendingPrompt && pendingResponse.length === 0) return;
    // JSONL transcripts carry no title, so the opening question stands in for
    // one -- it describes the topic far better than a bag of frequent terms.
    if (!title && pendingPrompt) {
      title = pendingPrompt.replace(/\s+/g, " ").trim().slice(0, 60);
    }
    turns.push({
      prompt: pendingPrompt.slice(0, MAX_TEXT_CHARS),
      response: pendingResponse.join("\n").slice(0, MAX_TEXT_CHARS),
      modelId,
      timestamp: ts,
    });
    pendingPrompt = "";
    pendingResponse = [];
  };

  for (const line of text.split("\n")) {
    if (turns.length >= MAX_TURNS_PER_SESSION) break;
    const trimmed = line.trim();
    if (!trimmed) continue;

    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = String(ev.type ?? "");
    const data = (ev.data ?? {}) as Record<string, unknown>;
    const ts = Date.parse(String(ev.timestamp ?? "")) || 0;

    if (type === "session.start") {
      modelId = String(data.model ?? data.producer ?? "");
      title = String(data.title ?? "");
    } else if (type === "user.message") {
      flush(ts);
      pendingPrompt = asText(data.content);
    } else if (type === "assistant.message") {
      const c = asText(data.content);
      if (c) pendingResponse.push(c);
    }
  }
  flush(0);
  return { title, turns };
}

export interface ScanOptions {
  /** When set, only sessions belonging to this workspace URI are read. */
  onlyWorkspaceUri?: string;
}

export interface ScanResult {
  turns: ChatTurn[];
  stats: ScanStats;
  /** Workspaces that had at least one readable session, for the picker. */
  workspaces: { uri: string; label: string; sessions: number }[];
}

/**
 * Cheap enumeration for the scope picker: counts candidate files per workspace
 * without parsing or redacting any of them. A full scan is 80s on a large
 * history; this is well under a second.
 */
export function listWorkspaces(
  log?: (msg: string) => void
): { uri: string; label: string; sessions: number }[] {
  const files = findSessionFiles(log);
  const byKey = new Map<string, { uri: string; label: string; sessions: number }>();
  const cache = new Map<string, string | undefined>();

  for (const f of files) {
    if (!cache.has(f.storageKey)) cache.set(f.storageKey, workspaceUriFor(f.storageKey));
    const uri = cache.get(f.storageKey);
    if (!uri) continue;
    const key = normalizeWorkspaceUri(uri);
    const entry = byKey.get(key);
    if (entry) {
      entry.sessions++;
    } else {
      byKey.set(key, { uri, label: workspaceLabel(uri), sessions: 1 });
    }
  }
  return [...byKey.values()].sort((a, b) => b.sessions - a.sessions);
}

export function scanSessions(
  onProgress?: (done: number, total: number) => void,
  log?: (msg: string) => void,
  options: ScanOptions = {}
): ScanResult {
  const all = findSessionFiles(log);
  const stats = emptyStats();
  const turns: ChatTurn[] = [];
  const wsCounts = new Map<string, { label: string; sessions: number }>();

  // Resolve workspaces once; workspace.json reads are not free over /mnt.
  const wsCache = new Map<string, string | undefined>();
  const wsFor = (key: string) => {
    if (!wsCache.has(key)) wsCache.set(key, workspaceUriFor(key));
    return wsCache.get(key);
  };

  const wanted = options.onlyWorkspaceUri;
  const files = wanted
    ? all.filter((f) => sameWorkspace(wsFor(f.storageKey), wanted))
    : all;
  if (wanted) log?.(`filtered to workspace ${wanted}: ${files.length} of ${all.length} files`);

  files.forEach((sf, i) => {
    onProgress?.(i + 1, files.length);

    let size = 0;
    try {
      size = fs.statSync(sf.file).size;
    } catch {
      stats.sessionsSkipped++;
      return;
    }
    if (size > MAX_SESSION_BYTES) {
      stats.sessionsSkipped++;
      return;
    }

    let text: string;
    try {
      text = fs.readFileSync(sf.file, "utf8");
    } catch {
      stats.sessionsSkipped++;
      return;
    }

    const parsed = readSession(text, sf.format);
    if (!parsed || parsed.turns.length === 0) {
      stats.sessionsSkipped++;
      return;
    }
    stats.sessionsSeen++;

    const wsUri = wsFor(sf.storageKey);
    if (wsUri) {
      const entry = wsCounts.get(wsUri) ?? { label: workspaceLabel(wsUri), sessions: 0 };
      entry.sessions++;
      wsCounts.set(wsUri, entry);
    }

    const sessionId = path.basename(sf.file).replace(/\.jsonl?$/, "");
    for (const t of parsed.turns) {
      if (!t.prompt && !t.response) continue;
      stats.turnsSeen++;

      const p = redact(t.prompt);
      const a = redact(t.response);
      if (p.excluded || a.excluded) {
        stats.turnsExcluded++;
        continue;
      }
      stats.valuesMasked += p.masked + a.masked;

      turns.push({
        sessionId,
        title: parsed.title,
        workspace: wsUri ?? sf.storageKey,
        modelId: t.modelId,
        timestamp: t.timestamp,
        prompt: p.text,
        response: a.text,
      });
    }
  });

  return {
    turns,
    stats,
    workspaces: [...wsCounts.entries()]
      .map(([uri, v]) => ({ uri, ...v }))
      .sort((a, b) => b.sessions - a.sessions),
  };
}
