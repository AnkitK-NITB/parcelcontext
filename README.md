# ParcelContext (VS Code extension)

Microsoft Global Hackathon 2026 · Concept · `proj-7f0ab4ff-69c6-4da3-9122-aae2032db19f`

Export, import, and share **reviewed** Copilot context across workspaces and teammates.

## Run it

```powershell
npm install
npm run compile
```

Then press **F5** ("Run ParcelContext"). A second VS Code window opens with the extension loaded.
Open the **ParcelContext** icon in the activity bar to see the Context Library.

## Building packs

Three ways, in rough order of how much you get for free:

| Command | What it does |
|---|---|
| **Scan Chat History For Packs** | Reads every stored chat session on this machine, groups them by topic, and proposes one pack per topic |
| **Save Context Pack** | Drafts a single pack from the current workspace's docs and git history |
| **Import Context Pack** | Brings in a `.ctxpack` a teammate exported |

And to reshape what you have: **Split Pack**, **Merge Packs**, **Refresh Pack From Workspace**.

### Selecting many items at once

VS Code's quick pick has no shift-click range selection, so every multi-select list
here carries three title-bar buttons instead:

| Button | Does |
|---|---|
| ✓ Select all shown | Ticks everything currently visible |
| ⌫ Clear all shown | Unticks everything currently visible |
| ⇄ Invert selection | Flips everything currently visible |

"Shown" means *after filtering*, which is what makes it useful: type `bug` to narrow the
list, hit **Select all shown**, and only the matching rows are ticked. That covers the
range-selection cases without needing the range gesture.

### How the scan works

1. Locates VS Code's stored chat sessions under `workspaceStorage/*/chatSessions/*.json`
   and `GitHub.copilot-chat/transcripts/*.jsonl`
2. Extracts each prompt/response pair, with its model id and timestamp
3. **Classifies and redacts automatically** — you are not asked to triage
4. Groups sessions into topics by term overlap
5. **Names each topic with a language model**, then proposes a pack per topic
6. For the topics you keep, the model rewrites the sections: merging
   near-duplicates, dropping fragments, and restating each item so it makes
   sense to someone who was not in the conversation

### Choosing the model

`ParcelContext: Select Model For Scanning` lists the models available to you, then
asks for a reasoning effort. The default is **Automatic**, which prefers MAI
families, then the fastest available. You can also pin a specific model, or turn
model use off entirely and fall back to local heuristics.

Three settings back this:

| Setting | Default | Meaning |
|---|---|---|
| `parcelcontext.scan.useModel` | `true` | Use a model for naming and refinement |
| `parcelcontext.scan.model` | `""` | Pin a model id; empty means automatic |
| `parcelcontext.scan.reasoningEffort` | `"default"` | `default` · `low` · `medium` · `high` |

**On reasoning effort:** the Language Model API has no first-class field for it.
The value is passed through `modelOptions`, which the API documents as
model-specific, so a model that does not recognise the key ignores it and the
scan proceeds normally. Treat it as a request, not a guarantee.

`default` is the right choice for most scans. `high` is worth trying when a
workspace has many overlapping topics and you want harder deduplication, at the
cost of a noticeably slower refinement pass.

Run `ParcelContext: Show Version And Diagnostics` to see which model and effort
are actually in force.

Naming is **one request for the whole topic list**, so the picker stays quick.
Refinement runs **only for the topics you keep**, so the expensive pass is never
spent on material you were about to discard. If no model is available, consent is
declined, or a reply is malformed, the scan silently falls back to heuristics —
labels get worse, nothing breaks.

### Running under WSL (or any remote window)

Chat sessions are workbench state, so they are written on the **client** machine even
when the extension host is remote. Under WSL the scan therefore reaches across the
`/mnt` bridge: it enumerates `/mnt/<drive>/Users/<user>/AppData/Roaming/<product>/User/…`
in addition to the Linux-side `~/.vscode-server/data/User/…`.

Measured on a real history: 86 session files, 763 exchanges, ~15s over `/mnt` versus
~12s natively on Windows. The `/mnt` filesystem is slower, which is part of why large
sessions are capped.

To install into the WSL host, run this **from a terminal inside the VS Code WSL window**:

```bash
./install-wsl.sh
```

It will not work from a plain `wsl.exe` shell, because the remote CLI needs that
window's IPC socket. The Extensions view also offers **Install in WSL: \<distro\>** once
the extension is installed locally.

If a scan finds nothing, the warning has a **Show details** button that opens the
`ParcelContext` output channel listing every path probed and how many files each held.

**Redaction is deliberately blunt.** Any exchange containing a private key, connection
string, bearer token, PAT, cloud access key or an assigned `secret`/`password` is dropped
whole — masking is not enough, because the surrounding sentence usually explains what the
secret is for. Emails, GUIDs, IPs and long hashes are masked in place. A false exclusion
costs one section; a false inclusion can leak a credential into a file you then share.

**Known limits of the scan:**
- The on-disk chat format is **internal to VS Code, not a public API**. It can change
  between releases. Every read is defensive, so a shape change degrades to "found nothing"
  rather than crashing — but it can degrade.
- Sessions over 12 MB are skipped. On a large history this is typically 10-15% of files,
  and they are usually long agent runs rather than design discussions.
- Only the first 40 exchanges of a session are read, and each is capped at 4000 characters.
- Clustering is term-overlap, not semantic. It reliably separates unrelated work; it will
  sometimes split one topic in two, which is what **Merge Packs** is for.

## The 90-second demo

This is the sequence to film. It matches the concept video beat for beat.

1. **Workspace A** — `ParcelContext: Save Context Pack`. Name it `Project Handoff`.
   Type a goal, a decision, a convention, an open question.
2. **The review gate appears** — a multi-select list with everything ticked.
   Untick one item to show that excluded content never leaves. Confirm.
3. **Export** — click the export icon on the pack. Save `project-handoff.ctxpack`.
   Open it in an editor: it's readable JSON, reviewable in a PR.
4. **Workspace B** — open a *different* folder. Library is empty.
   `ParcelContext: Import Context Pack` → pick the file.
   **The full contents render as Markdown before anything is imported.**
5. Choose **Import and enable here**.
6. Open Copilot Chat and ask something like
   *"What should I keep in mind before changing the payments endpoint?"*
   Reference the tool explicitly with `#contextPacks` if you want it guaranteed on camera.

`samples/project-handoff.ctxpack` is ready to import if you'd rather skip step 1 during a live demo.

## How Copilot retrieves it

Registered through the supported **Language Model Tool API**
(`vscode.lm.registerTool`), contributed as `parcelcontext_getContext` with the
prompt reference name `#contextPacks`.

Only packs that are **saved, reviewed, and explicitly enabled for the current
workspace** are ever returned. Enablement lives in `workspaceState`, so importing
a pack in one workspace does not expose it in another.

## Architecture

| File | Responsibility |
|---|---|
| `src/types.ts` | Pack schema, validation of untrusted `.ctxpack` files |
| `src/store.ts` | Library in global storage; per-workspace enablement |
| `src/packTool.ts` | Language Model Tool — what Copilot actually sees |
| `src/tree.ts` | Context Library tree view |
| `src/extension.ts` | Commands: save, list, export, import, share, enable, delete |

Packs live in `globalStorageUri/packs/*.ctxpack` so they travel between workspaces.

## Scope — read this before demoing

The honest boundary, and the thing to say out loud when a judge asks:

- The scan reads **chat sessions VS Code has already stored on this machine**. It reads
  them off disk directly, because the Chat Participant API only exposes messages addressed
  to that participant. That storage layout is internal and may change between releases.
- Exclusion is **automatic, not delegated to you** — but it is biased towards dropping
  content, and the scan reports how much it excluded and masked.
- Nothing is imported without a **full preview** first.
- Import conflicts are resolved by the user: keep existing, use incoming, or keep
  both. Nothing is overwritten automatically.
- Exporting a pack grants **no access** to any source system, and a shared file
  **cannot be recalled**. The share command says so in its own confirmation.
- This is a concept, not a released feature, and not affiliated with or endorsed
  by any product team.

That last section is not boilerplate. Curated-and-reviewable is the actual design
position, and it's stronger than claiming total recall.

## Not built yet

Deliberately out of scope for the hackathon build: pack versioning, signing,
section-level merge on conflict, and a shared team registry. Each is a real next
step, none is needed to prove the loop.
