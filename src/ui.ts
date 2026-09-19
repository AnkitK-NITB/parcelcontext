import * as vscode from "vscode";

/**
 * Multi-select list with bulk controls.
 *
 * VS Code's QuickPick has no shift-click range selection, so selecting or
 * clearing a long run of items is otherwise one click per row. These buttons,
 * combined with the filter box, cover the same ground: type to narrow, then
 * act on everything that matches.
 */
export interface PickManyOptions {
  title: string;
  placeholder?: string;
  /** Items ticked when the list opens. Defaults to all. */
  preselect?: (item: vscode.QuickPickItem) => boolean;
}

const BUTTONS = {
  all: {
    iconPath: new vscode.ThemeIcon("check-all"),
    tooltip: "Select all shown",
  },
  none: {
    iconPath: new vscode.ThemeIcon("clear-all"),
    tooltip: "Clear all shown",
  },
  invert: {
    iconPath: new vscode.ThemeIcon("arrow-swap"),
    tooltip: "Invert selection",
  },
} as const;

export function pickMany<T extends vscode.QuickPickItem>(
  items: T[],
  options: PickManyOptions
): Promise<T[] | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<T>();
    qp.title = options.title;
    qp.placeholder =
      options.placeholder ??
      "Type to filter, then use the buttons to select or clear everything shown";
    qp.canSelectMany = true;
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.ignoreFocusOut = true;
    qp.items = items;
    qp.buttons = [BUTTONS.all, BUTTONS.none, BUTTONS.invert];

    const preselect = options.preselect ?? (() => true);
    qp.selectedItems = items.filter(preselect);

    // Which rows the filter is currently showing. VS Code does not expose the
    // filtered set, so the same matching is repeated here to keep the buttons
    // honest about "shown".
    const shown = (): T[] => {
      const v = qp.value.trim().toLowerCase();
      if (!v) return items;
      const terms = v.split(/\s+/);
      return items.filter((i) => {
        const hay = `${i.label} ${i.description ?? ""} ${i.detail ?? ""}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      });
    };

    let done = false;
    const finish = (result: T[] | undefined) => {
      if (done) return;
      done = true;
      qp.hide();
      qp.dispose();
      resolve(result);
    };

    qp.onDidTriggerButton((button) => {
      const visible = shown();
      const selected = new Set<T>(qp.selectedItems);

      if (button === BUTTONS.all) {
        for (const i of visible) selected.add(i);
      } else if (button === BUTTONS.none) {
        for (const i of visible) selected.delete(i);
      } else if (button === BUTTONS.invert) {
        for (const i of visible) {
          if (selected.has(i)) selected.delete(i);
          else selected.add(i);
        }
      }
      qp.selectedItems = items.filter((i) => selected.has(i));
    });

    qp.onDidAccept(() => finish([...qp.selectedItems]));
    qp.onDidHide(() => finish(undefined));
    qp.show();
  });
}
