# ParcelContext — P1 verification & P3 capture checklist

Everything here needs a human at the keyboard: P1 requires driving Copilot Chat in a
second window, P3 requires a screen recorder. Budget ~25 minutes for both.

The extension is already installed as `hackathon2026.parcelcontext`. To iterate on code
instead, press **F5** from the extension folder.

---

## P1 — Verify the loop (~10 min)

**Success criterion:** a Copilot answer in a *second, different* workspace is visibly
grounded in a pack that was authored in the first one.

### Setup
- [x] Create two throwaway folders: `demo-evidence\atlas-web` and `demo-evidence\atlas-mobile`
- [x] Put one junk file in each so they open as real workspaces (`demo.txt`)
- [ ] Confirm GitHub Copilot Chat is signed in and working

> **Changed since you started this checklist.** Packs are now drafted automatically
> from workspace evidence instead of typed by hand, so a folder containing only
> `demo.txt` will refuse to draft — "No docs or commit history found" is the
> intended behaviour, not a bug.
>
> Give each demo folder a `README.md` and a couple of commits:
> ```powershell
> cd demo-evidence\atlas-web
> git init; git add -A; git commit -m "Add checkout surface"
> ```
> Or point the demo at a real repo, which records better anyway.

### Workspace A — author and export
- [x] Open `atlas-web`. The **ParcelContext** icon appears in the activity bar
- [ ] Run **ParcelContext: Save Context Pack**
- [ ] Name: `Project Handoff`
- [ ] Description: `Background needed to pick up the checkout migration`
- [ ] A progress notification reads *"Reading workspace evidence… / Drafting context pack…"*
- [ ] **Review gate appears, pre-filled from the README, git log and changed files** — untick one item, confirm. *This is the money shot.*
- [ ] Pack appears in the Context Library tree
- [ ] Click the **export** icon → save as `project-handoff.ctxpack`
- [ ] Open the exported file in an editor — confirm it's readable JSON

### Workspace B — import and ground an answer
- [ ] Open `atlas-mobile` (File → Open Folder). **Library is empty** — say this out loud on camera
- [ ] Run **ParcelContext: Import Context Pack** → pick the file
- [ ] **Full contents render as Markdown before the import prompt**
- [ ] Choose **Import and enable here**
- [ ] Open Copilot Chat and ask:
      `#contextPacks What should I keep in mind before changing the payments endpoint?`
- [ ] ✅ **PASS** if the answer references the API-contract decision or the versioning question

### If the tool doesn't fire
The model decides when to call a tool. `#contextPacks` forces it — use the explicit
reference for the recording. If it still doesn't fire, check **Output → GitHub Copilot**
for tool registration errors, and confirm VS Code is **1.95+**.

### Also worth verifying
- [ ] Go back to workspace A — the pack is there but **not** auto-enabled in B's absence
- [ ] Import the same file twice → conflict prompt offers keep / use incoming / keep both
- [ ] Rename `.ctxpack` to garbage JSON and import → clean error, no crash

---

## P3 — Capture (~15 min)

**Target:** 60–90s, 1080p, no audio needed (the concept video already has narration).

### Before recording
- [ ] Set VS Code zoom to **+2** (`Ctrl+=`) — text must be readable in a scaled-down video
- [ ] Use a light theme to match the concept video's visual language
- [ ] Hide the terminal and minimap
- [ ] Close unrelated editors and notifications
- [ ] Do one full dry run before hitting record

### Shot list
| # | Shot | Hold |
|---|---|---|
| 1 | Workspace A, Context Library visible | 3s |
| 2 | Save Context Pack — typing the goal | 6s |
| 3 | **Review gate, unticking an item** | 6s |
| 4 | Export → file saved, shown in explorer | 5s |
| 5 | **Open workspace B — empty library** | 4s |
| 6 | Import → Markdown preview of contents | 8s |
| 7 | Enable for this workspace | 3s |
| 8 | Copilot answer citing the pack | 10s |

Shots 3, 5 and 6 are the ones that prove the claims. Shot 5 in particular is what makes
the handoff believable — an empty library in a different folder.

### After
- [ ] Trim to under 90s
- [ ] Either upload as the ParcelContext submission video, or splice shots 3/5/6/8 into
      the existing concept video to replace the equivalent mockups

---

## Regression check before submitting

### Execution notes - 2026-09-15 (in progress)

- Latest resume at 13:59: verified `atlas-web` open with the ParcelContext
  activity-bar icon after the user resolved trust. Checked that item only.
  Created a second VS Code window and opened its Open Folder dialog for
  `demo-evidence\atlas-mobile`. Both text insertion and direct field-value
  replacement were interrupted by the UI engine's user-input safeguard.
  The dialog remains open; selecting and trusting workspace B is pending.
  No numbered screenshot files have been saved. Earlier notes below describe
  previous attempts, not the latest workspace A trust state.
- Resume check at 13:54: `atlas-web` is now open at the expected demo-evidence
  path with `demo.txt` visible. VS Code is in Restricted Mode: this folder is
  not trusted, Copilot is disabled, and model selection is unavailable.
  The user must review and resolve workspace trust manually before the demo
  can proceed. No new screenshot files have been saved on this resume.
- Created both demo workspace folders alongside this checklist.
- Observed ParcelContext 0.1.0 installed and its activity-bar icon in the existing
  sample-core WSL window. This does not yet verify workspace A.
- Opened a separate Welcome window to avoid changing existing workspaces.
- UI automation blocked by repeated user-input interruptions in VS Code.
  Retried after the user confirmed VS Code was idle; the Open Folder action
  was interrupted again. Workspace A has not been opened.
- One diagnostic screenshot was returned in chat, but no demo screenshot files
  have been saved yet. Review gate, empty workspace B, import preview, and grounded
  answer still need authentic captures; none is marked verified.
- P1 loop, P3 recording, and regression commands have not been completed.
- No Copilot projects are configured; regression execution is pending project setup.

```powershell
cd parcelcontext-extension
npm test          # 10 parse tests
npm run package   # rebuilds the .vsix
```

```powershell
cd ado-sync-agent
npm test          # 16 matcher/state/dedupe evals
npm run run       # full dry-run pipeline
```
