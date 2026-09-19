# ParcelContext — demo shot list

Microsoft Global Hackathon 2026 · `proj-7f0ab4ff-69c6-4da3-9122-aae2032db19f`

**v0.9.0**, installed in the WSL host, 89 passing tests. Every shot below is real
working software — no mockups, no staged data.

> Supersedes `DEMO-CHECKLIST.md`, which was written to verify the loop worked
> before it did. It works now; this is about filming it.

---

## The one-sentence story

**Context is trapped in one workspace. A pack sets it free.**

Every shot serves that. If a shot does not advance it, cut the shot.

---

## Before you record

More important than the shot list. A demo unreadable at 1080p is a wasted demo.

- [ ] **Zoom to +2** — `Ctrl+=` twice. Text must survive video compression.
- [ ] **Light theme**, matching the concept video.
- [ ] Hide the minimap and breadcrumbs. Close unrelated editors and terminals.
- [ ] Dismiss any notification badges before you start.
- [ ] `Developer: Reload Window`.
- [ ] `ParcelContext: Show Version And Diagnostics` → confirm **0.9.0**, host `wsl`,
      and that a model is resolved. If it says heuristics, fix that first —
      Shot 3 depends on it.
- [ ] **Do one silent full dry run.** Every step is verified, but you want the
      muscle memory and you want to know where the pauses are.

### Reset to zero packs

You currently have **1 pack**. Shot 2 needs an empty library:

```bash
# from a terminal INSIDE the VS Code WSL window
rm -f ~/.vscode-server/data/User/globalStorage/hackathon2026.parcelcontext/packs/*.ctxpack
```

Then `Developer: Reload Window` → the welcome screen appears.

> Reset this way between takes. Re-scanning now *updates* packs rather than
> duplicating them — correct behaviour, but it means take two will not reproduce
> the "empty → 15 packs" moment unless you clear first.

### Pick your two workspaces

Shot 8 needs two **real** folders with genuine chat history. Recommended:

| Role | Folder | Why |
|---|---|---|
| Workspace A | `~/sample-core` | 65 sessions — richest history |
| Workspace B | `~/sample-edge` | different repo, makes the handoff obvious |

---

## The shots — 10 shots, ~2m30s of raw footage

### Shot 1 — The problem (10s)

Two VS Code windows, two different repos, two Copilot Chats. Capture yourself
typing the same background into the second one.

> The only re-enactment in the demo. Keep it under ten seconds — everything
> after this is real, and you want to get there fast.

**Narration:** *"I explain the same context every time I switch repos."*

---

### Shot 2 — Empty library → scan (20s) ⭐

1. Open the **ParcelContext** view. Welcome screen, no packs.
2. Click **Scan for packs**.
3. **Hold on the scope picker for a beat.** Your current workspace is first:
   `$(folder-active) sample-core · 65 sessions · this workspace`
4. Select it.
5. Progress: *"Reading session N of M…"* → *"naming 15 topics with …"*

**Narration:** *"It reads the chat history already on this machine — and it knows
which workspace I'm in."*

That scope picker is worth the pause. It shows the tool located 65 real sessions
for this folder specifically, not a blind sweep.

---

### Shot 3 — Topics with real names (15s) ⭐

The picker after naming completes. Capture the list and the header:

```
15 topics — 0 exchanges auto-excluded, 563 values masked

Async workload profile bug            5 sections
BOSS meeting transcript review        4 sections
DPU crash dump analysis               5 sections
FunOS WU stack gate bug               6 sections
Snap request initialization crash     7 sections
Work unit continuation pattern        6 sections
```

**Narration:** *"A model read the exchanges and named each topic. Without it, the
first one would be called `C:\Users\…\BOSS_SNAP Deep Dive (3`."*

Call out `563 values masked` — redaction ran automatically and the user was never
asked to triage anything.

---

### Shot 4 — Bulk selection (10s)

With the topic picker still open:

1. Type `bug` in the filter — the list narrows.
2. Click **✓ Select all shown** in the title bar.
3. Clear the filter — only the bug topics remain ticked.

**Narration:** *"VS Code's picker has no shift-click range select, so filter plus
select-all does the same job."*

Small shot, but it answers an obvious "how do I pick twenty of these" question
before a judge asks it.

---

### Shot 5 — A pack with real content (15s) ⭐

Expand **Work unit continuation pattern** in the tree:

```
Goals:          Understand continuation pattern
Decisions:      Yield on slow work
Notes:          Continuation can move cores
References:     PBI context
Open questions: Implementation details
```

Click a section to open the Markdown detail view — shows source workspace and
review date.

**Narration:** *"These are decisions and open questions pulled out of the
conversation, not a transcript of it."*

---

### Shot 6 — Search across packs (12s)

1. Click the 🔍 in the view title bar.
2. Type `continuation`.
3. Capture section-level hits, each labelled with its parent pack:

```
$(symbol-string) Yield on slow work    decision · Work unit continuation pattern
                 …pushes another work unit and returns so the current work…
```

**Narration:** *"Search goes inside the packs, not just across their names."*

---

### Shot 7 — Model and reasoning effort (12s)

1. **Hover the status bar** entry, bottom right: `$(sparkle) <model>`.
   Tooltip table: Model / Context / Effort / Chosen / Id.
2. **Click it.** Picker shows models with context size inline, the current one
   checked, a ⚙ on each row, and a `Reasoning effort:` row.

**Narration:** *"You choose the model and the effort. It defaults to MAI."*

---

### Shot 8 — Export → different workspace → import (25s) ⭐⭐

**The shot that proves the whole premise. Do not rush it.**

1. Right-click a pack → **Export**. Save as `.ctxpack`.
2. **Open the exported file in an editor.** Readable JSON — reviewable in a PR.
3. `File → Open Folder` → **Workspace B** (`~/sample-edge`).
4. Open the ParcelContext view. **It is empty.**
   → **Let this sit on screen for two full seconds.**
5. **Import a pack** → select the file.
6. **The full contents render as Markdown before the import prompt appears.**
7. Choose **Import and enable here**.

**Narration at step 4:** *"Different repo. Nothing here."*
**Narration at step 6:** *"Nothing is imported unseen — this is the whole pack,
before I accept it."*

Step 4 is what makes the handoff believable. Every instinct will be to click
through it quickly. Don't.

---

### Shot 9 — Copilot grounded in the pack (15s) ⭐

Still in Workspace B, open Copilot Chat:

```
#contextPacks What should I know about the work unit continuation pattern?
```

Capture the answer citing pack content.

> **Rehearse this one.** The model decides when to invoke a tool on its own, so
> the explicit `#contextPacks` reference is what makes it deterministic on
> camera. This is the single shot most likely to misbehave live.

**Narration:** *"Different workspace, and Copilot already knows."*

---

### Shot 10 — Evidence (15s, optional but worth it)

```bash
cd parcelcontext-extension && npm test
```

→ **89 passing**

Then `ParcelContext: Show Version And Diagnostics` — version, host `wsl`, the
resolved model, effort, and every available model with its raw fields.

**Narration:** *"The eval suite found three real bugs while building this."*

Those three: recently-touched items auto-matching despite the stated policy,
conversational filler leaking into updates, and a tier-band overlap that broke
the documented priority order. "Tests that caught something" beats "tests that
pass".

---

## Priority, if you run short

| Rank | Shot | Why it earns its place |
|---|---|---|
| 1 | **8** — export → new workspace → import | Proves the entire premise |
| 2 | **3** — model-named topics | Proves the quality jump |
| 3 | **9** — Copilot grounded in the pack | Closes the loop |
| 4 | **2** — empty library → scan | Sets up shot 8 |
| 5 | **5** — pack contents | Shows it captured knowledge, not chatter |

Shots 8 + 3 + 9 alone are a complete, convincing 60-second demo.

---

## If something goes wrong on camera

| Symptom | Cause | Fix |
|---|---|---|
| Scan finds 0 sessions | Wrong host, or path probe failed | Warning has **Show details** → opens the output channel listing every path probed |
| Topics named like file paths | No model resolved | Status bar will read `Heuristics`. Check Copilot Chat is signed in, then reload |
| `#contextPacks` returns nothing | Pack saved but not enabled | Right-click the pack → **Enable/Disable Pack for This Workspace** |
| Scan produces duplicates | Pre-0.4.0 packs have random ids | Delete them: **Delete Context Packs** → *Select all shown* |
| Version shows old number | Stale install | `./install-wsl.sh` — it purges old versions first — then reload |

---

## Things worth saying out loud

Stated limits land better with judges than glossing over them. All true:

- The VS Code chat store is **internal, not a public API**. Reads are defensive;
  a format change degrades to "found nothing" rather than crashing.
- Redaction is **deliberately blunt** — any exchange containing a key, token, or
  assigned secret is dropped whole, because masking leaves the surrounding
  sentence explaining what the secret was for.
- Reasoning effort goes through `modelOptions`, documented as model-specific.
  **A request, not a guarantee.**
- Exporting grants **no access** to any source system, and a shared file
  **cannot be recalled**. The share command says so itself.
- This is a concept, not a shipping feature, and not endorsed by any product team.

---

## Locations

| What | Path |
|---|---|
| This file | `parcelcontext-extension/DEMO-SHOT-LIST.md` |
| From WSL | `/mnt/c/Users/ankkushwaha/.copilot/chats/23015cfa-c7d7-432f-9f90-f109ebe2d65f/parcelcontext-extension/DEMO-SHOT-LIST.md` |
| Package | `parcelcontext-0.9.0.vsix` |
| Install to WSL | `./install-wsl.sh` — from a terminal inside the VS Code WSL window |
| Concept video | `../parcelcontext-video/ParcelContext-Concept-90s.mp4` |
| Pack storage | `~/.vscode-server/data/User/globalStorage/hackathon2026.parcelcontext/packs/` |
