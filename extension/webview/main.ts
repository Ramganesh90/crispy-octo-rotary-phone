/**
 * The resolver UI.
 *
 * Deliberately framework-free: the view is a small amount of DOM over a
 * `MergeDocument`, and every mutation goes to the extension host, which owns
 * the document and recomputes the preview. The webview keeps no merge logic.
 */

import type { HostMessage, VsCodeApi, WebviewMessage } from "../src/ui/messages";
import type { MergeDocument, MergeNode, Side } from "../src/merge/types";

import "./styles.css";

declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

const SIDES: Side[] = ["base", "ours", "theirs"];
const SIDE_LABEL: Record<Side, string> = {
  base: "Base",
  ours: "Ours",
  theirs: "Theirs",
};

interface State {
  path: string;
  doc: MergeDocument;
  conflictsOnly: boolean;
  collapsed: Set<string>;
  /** Node whose inline value editor is open. */
  editing?: string;
  /** Node the keyboard is on. */
  current?: string;
  preview: string;
  applied: boolean;
}

let state: State | undefined;

function post(message: WebviewMessage): void {
  vscode.postMessage(message);
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** Leaf conflicts in view order — what the keyboard steps through. */
function conflictLeaves(nodes: MergeNode[], into: MergeNode[] = []): MergeNode[] {
  for (const node of nodes) {
    if (node.children) {
      conflictLeaves(node.children, into);
    } else if (node.status === "conflict") {
      into.push(node);
    }
  }
  return into;
}

function hasConflictBelow(node: MergeNode): boolean {
  if (!node.children) {
    return node.status === "conflict";
  }
  return node.children.some(hasConflictBelow);
}

function stateLabel(node: MergeNode): { text: string; className: string } {
  switch (node.status) {
    case "unchanged":
      return { text: "unchanged", className: "state" };
    case "both-same":
      return { text: "same on both sides", className: "state" };
    case "ours-only":
      return {
        text: node.sides.ours.present ? "changed by us" : "deleted by us",
        className: "state",
      };
    case "theirs-only":
      return {
        text: node.sides.theirs.present
          ? node.sides.base.present
            ? "changed by them"
            : "added by them"
          : "deleted by them",
        className: "state added",
      };
    case "conflict":
      return { text: "both changed", className: "state" };
  }
}

function describe(node: MergeNode, side: Side): string {
  const value = node.sides[side];
  return value.present ? value.display : "(removed)";
}

function renderChoices(node: MergeNode): HTMLElement {
  const wrap = element("div", "choices");

  for (const side of SIDES) {
    // Base is only worth offering when it differs from both sides.
    if (side === "base" && !node.sides.base.present) {
      continue;
    }
    const selected =
      node.resolution.kind === "side" && node.resolution.side === side;
    const button = element("button", "choice");
    if (!node.sides[side].present) {
      button.classList.add("absent");
    }
    button.setAttribute("aria-pressed", String(selected));
    button.append(
      element("span", "side", SIDE_LABEL[side]),
      element("span", "val", describe(node, side)),
    );
    button.title = `Use the ${SIDE_LABEL[side].toLowerCase()} value for ${node.label}`;
    button.addEventListener("click", () => choose(node, side));
    wrap.append(button);
  }

  const custom = element("button", "choice");
  const customText =
    node.resolution.kind === "custom" ? node.resolution.text : undefined;
  custom.setAttribute("aria-pressed", String(customText !== undefined));
  custom.append(
    element("span", "side", "Edit"),
    element("span", "val", customText ?? "…"),
  );
  custom.title = `Type a different value for ${node.label}`;
  custom.addEventListener("click", () => {
    if (state) {
      state.editing = state.editing === node.id ? undefined : node.id;
      state.current = node.id;
      render();
    }
  });
  wrap.append(custom);
  return wrap;
}

function renderCustomEditor(node: MergeNode): HTMLElement {
  const wrap = element("div", "custom-editor");
  const input = element("input");
  input.type = "text";
  input.value =
    node.resolution.kind === "custom"
      ? node.resolution.text
      : (node.sides.ours.present ? node.sides.ours.display : "");
  input.setAttribute("aria-label", `Value for ${node.label}`);

  const commit = () => {
    post({
      type: "setResolution",
      nodeId: node.id,
      resolution: { kind: "custom", text: input.value },
    });
    if (state) {
      node.resolution = { kind: "custom", text: input.value };
      state.editing = undefined;
      render();
    }
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (state) {
        state.editing = undefined;
        render();
      }
    }
    event.stopPropagation(); // typing must not trigger the global shortcuts
  });

  const save = element("button", "primary", "Set");
  save.addEventListener("click", commit);

  wrap.append(input, save);
  // Focus after the element is in the document.
  queueMicrotask(() => input.focus());
  return wrap;
}

function choose(node: MergeNode, side: Side): void {
  node.resolution = { kind: "side", side };
  post({ type: "setResolution", nodeId: node.id, resolution: node.resolution });
  if (state) {
    state.current = node.id;
    state.editing = undefined;
  }
  render();
}

function renderNode(node: MergeNode, depth: number, into: HTMLElement): void {
  if (!state) {
    return;
  }
  const isConflict = !node.children && node.status === "conflict";

  if (state.conflictsOnly && !hasConflictBelow(node)) {
    return;
  }

  const row = element("div", "row");
  row.style.paddingLeft = `${12 + depth * 16}px`;
  if (isConflict) {
    row.classList.add("conflict");
  }
  if (state.current === node.id) {
    row.classList.add("current");
  }

  if (node.children) {
    const collapsed = state.collapsed.has(node.id);
    row.classList.add("container");
    row.tabIndex = 0;
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-expanded", String(!collapsed));
    row.append(
      element("span", "twisty", collapsed ? "▸" : "▾"),
      element("span", "key", node.label),
    );
    const conflicts = conflictLeaves(node.children).length;
    row.append(
      element(
        "span",
        conflicts > 0 ? "state" : "state added",
        conflicts > 0
          ? `${conflicts} conflict${conflicts === 1 ? "" : "s"}`
          : "merges cleanly",
      ),
    );
    const toggle = () => {
      if (collapsed) {
        state?.collapsed.delete(node.id);
      } else {
        state?.collapsed.add(node.id);
      }
      render();
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });
    into.append(row);

    if (!collapsed) {
      for (const child of node.children) {
        renderNode(child, depth + 1, into);
      }
    }
    return;
  }

  // A glyph as well as colour: conflicts must be findable without relying on
  // colour perception.
  row.append(
    element("span", "twisty", ""),
    ...(isConflict ? [element("span", "marker", "⚠")] : []),
    element("span", "key", node.label),
  );

  if (isConflict) {
    row.append(renderChoices(node));
  } else {
    const resolved =
      node.status === "theirs-only" ? node.sides.theirs : node.sides.ours;
    row.append(
      element("span", "value", resolved.present ? resolved.display : "(removed)"),
    );
    const label = stateLabel(node);
    row.append(element("span", label.className, label.text));
  }

  into.append(row);

  if (state.editing === node.id) {
    into.append(renderCustomEditor(node));
  }
}

/**
 * A lockfile gets one card instead of a tree: merging it key by key produces
 * a tree that may not install, so the real choice is which side to keep and
 * whether to regenerate.
 */
function renderLockfileCard(node: MergeNode): HTMLElement {
  const card = element("div", "card");
  card.append(
    element("h3", undefined, "This is a generated lockfile"),
    element(
      "p",
      undefined,
      "Merging a lockfile entry by entry can produce a dependency tree that " +
        "does not install. Keep one side, then regenerate it from package.json.",
    ),
  );

  const choices = element("div", "choices");
  for (const side of ["ours", "theirs"] as const) {
    const selected = node.resolution.kind === "side" && node.resolution.side === side;
    const button = element("button", "choice");
    button.setAttribute("aria-pressed", String(selected));
    button.append(
      element("span", "side", side === "ours" ? "Keep ours" : "Keep theirs"),
      element("span", "val", node.sides[side].display),
    );
    button.addEventListener("click", () => choose(node, side));
    choices.append(button);
  }
  card.append(choices);
  return card;
}

function renderToolbar(): HTMLElement {
  const bar = element("div", "toolbar");
  const doc = state!.doc;

  bar.append(element("span", "path", state!.path));

  if (doc.conflictCount > 0) {
    bar.append(
      element(
        "span",
        doc.unresolvedCount > 0 ? "badge warn" : "badge",
        `${doc.conflictCount} conflict${doc.conflictCount === 1 ? "" : "s"}`,
      ),
    );
  } else {
    bar.append(element("span", "badge", "merges cleanly"));
  }

  // Bulk actions and the filter only make sense over a tree of decisions; a
  // lockfile is a single choice.
  if (doc.conflictCount > 0 && doc.format !== "lockfile") {
    const allOurs = element("button", undefined, "All ours");
    allOurs.addEventListener("click", () => post({ type: "setAll", side: "ours" }));
    const allTheirs = element("button", undefined, "All theirs");
    allTheirs.addEventListener("click", () => post({ type: "setAll", side: "theirs" }));

    const filter = element("label", "check");
    const box = element("input");
    box.type = "checkbox";
    box.checked = state!.conflictsOnly;
    box.addEventListener("change", () => {
      if (state) {
        state.conflictsOnly = box.checked;
        render();
      }
    });
    filter.append(box, document.createTextNode("Conflicts only"));

    bar.append(allOurs, allTheirs, filter);
  }

  return bar;
}

function renderFooter(): HTMLElement {
  const footer = element("div", "footer");
  const doc = state!.doc;
  const unresolved = doc.unresolvedCount;

  footer.append(
    element(
      "span",
      unresolved > 0 ? "status warn" : "status",
      state!.applied
        ? "Applied."
        : unresolved > 0
          ? `${unresolved} conflict${unresolved === 1 ? "" : "s"} still need a decision`
          : doc.conflictCount > 0
            ? "All conflicts resolved"
            : "Nothing to decide — review and apply",
    ),
  );

  const text = element("button", undefined, "Open as text");
  text.addEventListener("click", () => post({ type: "openTextEditor" }));

  if (state!.doc.format === "lockfile") {
    const regenerate = element("button", undefined, "Regenerate with npm");
    regenerate.title =
      "Rebuild the lockfile from package.json instead of merging it. " +
      "You will be asked to confirm the command first.";
    regenerate.addEventListener("click", () => post({ type: "regenerateLockfile" }));
    footer.append(regenerate);
  }

  const applyOnly = element("button", undefined, "Apply");
  applyOnly.disabled = unresolved > 0;
  applyOnly.title = "Write the merged file without staging it";
  applyOnly.addEventListener("click", () => post({ type: "apply", stage: false }));

  const applyStage = element("button", "primary", "Apply & mark resolved");
  applyStage.disabled = unresolved > 0;
  applyStage.title = "Write the merged file and stage it";
  applyStage.addEventListener("click", () => post({ type: "apply", stage: true }));

  footer.append(text, applyOnly, applyStage);
  return footer;
}

function renderPreview(): HTMLElement {
  const wrap = element("div", "preview");
  wrap.append(element("h2", undefined, "Result"));
  const pre = element("pre");
  pre.textContent = state!.preview;
  wrap.append(pre);
  return wrap;
}

function render(): void {
  const root = document.getElementById("root");
  if (!root || !state) {
    return;
  }
  root.className = "";
  root.replaceChildren();

  root.append(renderToolbar());

  const tree = element("div", "tree");
  tree.setAttribute("role", "tree");
  if (state.doc.format === "lockfile") {
    tree.append(renderLockfileCard(state.doc.root[0]));
  } else {
    for (const node of state.doc.root) {
      renderNode(node, 0, tree);
    }
  }
  if (tree.childElementCount === 0) {
    tree.append(
      element(
        "div",
        "message",
        state.conflictsOnly
          ? "No conflicts to show. Clear the filter to see the whole document."
          : "This file has no differences to merge.",
      ),
    );
  }
  root.append(tree);

  if (state.doc.conflictCount > 0 && state.doc.format !== "lockfile") {
    root.append(
      (() => {
        const hint = element("div", "hint");
        hint.innerHTML =
          "<kbd>j</kbd>/<kbd>k</kbd> move between conflicts · " +
          "<kbd>1</kbd> base <kbd>2</kbd> ours <kbd>3</kbd> theirs · " +
          "<kbd>e</kbd> type a value";
        return hint;
      })(),
    );
  }

  root.append(renderPreview(), renderFooter());
}

function showMessage(message: string, canFallBackToText: boolean): void {
  const root = document.getElementById("root");
  if (!root) {
    return;
  }
  root.className = "";
  root.replaceChildren();
  root.append(element("div", "message", message));
  if (canFallBackToText) {
    const footer = element("div", "footer");
    const open = element("button", "primary", "Open in text editor");
    open.addEventListener("click", () => post({ type: "openTextEditor" }));
    footer.append(open);
    root.append(footer);
  }
}

/** Moves the keyboard cursor by `delta` conflicts and selects it. */
function moveCurrent(delta: number): void {
  if (!state) {
    return;
  }
  const leaves = conflictLeaves(state.doc.root);
  if (leaves.length === 0) {
    return;
  }
  const index = leaves.findIndex((n) => n.id === state!.current);
  const next = index === -1 ? 0 : Math.min(leaves.length - 1, Math.max(0, index + delta));
  state.current = leaves[next].id;
  state.editing = undefined;
  render();
  document.querySelector(".row.current")?.scrollIntoView({ block: "nearest" });
}

function currentNode(): MergeNode | undefined {
  if (!state?.current) {
    return undefined;
  }
  return conflictLeaves(state.doc.root).find((n) => n.id === state!.current);
}

document.addEventListener("keydown", (event) => {
  if (!state || event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }
  const target = event.target as HTMLElement | null;
  if (target?.tagName === "INPUT") {
    return;
  }

  switch (event.key) {
    case "j":
    case "ArrowDown":
      event.preventDefault();
      moveCurrent(1);
      return;
    case "k":
    case "ArrowUp":
      event.preventDefault();
      moveCurrent(-1);
      return;
    case "1":
    case "2":
    case "3": {
      const node = currentNode() ?? conflictLeaves(state.doc.root)[0];
      if (node) {
        const side = SIDES[Number(event.key) - 1];
        if (node.sides[side].present || side !== "base") {
          event.preventDefault();
          choose(node, side);
        }
      }
      return;
    }
    case "e": {
      const node = currentNode() ?? conflictLeaves(state.doc.root)[0];
      if (node) {
        event.preventDefault();
        state.editing = node.id;
        state.current = node.id;
        render();
      }
      return;
    }
    default:
  }
});

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "loaded": {
      const collapsed = state?.collapsed ?? new Set<string>();
      // Collapse clean containers on first load so conflicts are what you see.
      if (!state) {
        for (const node of message.doc.root) {
          if (node.children && !hasConflictBelow(node)) {
            collapsed.add(node.id);
          }
        }
      }
      state = {
        path: message.path,
        doc: message.doc,
        conflictsOnly: state?.conflictsOnly ?? false,
        collapsed,
        current: conflictLeaves(message.doc.root)[0]?.id,
        preview: state?.preview ?? "",
        applied: false,
      };
      render();
      return;
    }
    case "counts":
      if (state) {
        state.doc.conflictCount = message.conflictCount;
        state.doc.unresolvedCount = message.unresolvedCount;
        render();
      }
      return;
    case "preview":
      if (state) {
        state.preview = message.text;
        const pre = document.querySelector(".preview pre");
        if (pre) {
          pre.textContent = message.text;
        } else {
          render();
        }
      }
      return;
    case "applied":
      if (state) {
        state.applied = true;
        render();
      }
      return;
    case "error":
      showMessage(message.message, message.canFallBackToText);
      return;
  }
});

post({ type: "ready" });
