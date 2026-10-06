/**
 * The "Conflicted Files" sidebar: repositories grouped over their conflicted
 * files, each file labelled with what resolving it will take.
 */

import * as vscode from "vscode";

import { type ConflictFile, findConflicts } from "../conflicts";

type TreeItem = RepoItem | FileItem;

class RepoItem extends vscode.TreeItem {
  constructor(
    readonly root: string,
    name: string,
    readonly files: ConflictFile[],
  ) {
    super(name, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "repo";
    this.iconPath = new vscode.ThemeIcon("repo");
    const conflicts = files.reduce(
      (sum, f) => sum + (f.state.kind === "structural" ? f.state.conflictCount : 0),
      0,
    );
    this.description = `${files.length} file${files.length === 1 ? "" : "s"}${
      conflicts > 0 ? `, ${conflicts} conflict${conflicts === 1 ? "" : "s"}` : ""
    }`;
  }
}

class FileItem extends vscode.TreeItem {
  constructor(readonly file: ConflictFile) {
    super(vscode.Uri.file(file.path).path.split("/").pop() ?? file.path);
    this.resourceUri = file.uri;
    this.contextValue = `conflict:${file.state.kind}`;
    this.tooltip = new vscode.MarkdownString(tooltipFor(file));

    const dir = file.path.includes("/")
      ? file.path.slice(0, file.path.lastIndexOf("/"))
      : "";

    switch (file.state.kind) {
      case "structural":
        this.description = `${dir ? dir + " · " : ""}${file.state.conflictCount} conflict${
          file.state.conflictCount === 1 ? "" : "s"
        }`;
        this.iconPath = new vscode.ThemeIcon(
          "git-merge",
          new vscode.ThemeColor("gitDecoration.conflictingResourceForeground"),
        );
        this.command = {
          command: "structuralMerge.resolve",
          title: "Resolve",
          arguments: [file],
        };
        break;
      case "clean":
        this.description = `${dir ? dir + " · " : ""}merges cleanly`;
        this.iconPath = new vscode.ThemeIcon(
          "check",
          new vscode.ThemeColor("gitDecoration.addedResourceForeground"),
        );
        this.command = {
          command: "structuralMerge.resolve",
          title: "Review and apply",
          arguments: [file],
        };
        break;
      case "text":
        this.description = `${dir ? dir + " · " : ""}text merge`;
        this.iconPath = new vscode.ThemeIcon("file-code");
        this.command = {
          command: "structuralMerge.openInTextEditor",
          title: "Open",
          arguments: [file],
        };
        break;
    }
  }
}

function tooltipFor(file: ConflictFile): string {
  const lines = [`**${file.path}**`, ""];
  switch (file.state.kind) {
    case "structural":
      lines.push(
        `${file.state.conflictCount} key${file.state.conflictCount === 1 ? "" : "s"} changed on both sides.`,
        "",
        "Click to resolve them key by key.",
      );
      break;
    case "clean":
      lines.push(
        "Every change merges without a decision.",
        "",
        "Click to review the result and apply it.",
      );
      break;
    case "text":
      lines.push(
        `Cannot be merged structurally: ${file.state.reason}.`,
        "",
        "Click to open it in the text editor.",
      );
      break;
  }
  return lines.join("\n");
}

export class ConflictTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private readonly changed = new vscode.EventEmitter<TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private files: ConflictFile[] = [];
  private loading?: Promise<void>;

  /** The current conflicts, as of the last refresh. */
  get conflicts(): readonly ConflictFile[] {
    return this.files;
  }

  refresh(): void {
    this.loading = undefined;
    this.changed.fire(undefined);
  }

  private load(): Promise<void> {
    // Coalesce the bursts of refreshes that a single git command produces.
    this.loading ??= findConflicts().then((files) => {
      this.files = files;
      void vscode.commands.executeCommand(
        "setContext",
        "structuralMerge.hasConflicts",
        files.length > 0,
      );
    });
    return this.loading;
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    await this.load();

    if (element === undefined) {
      const byRepo = new Map<string, ConflictFile[]>();
      for (const file of this.files) {
        const existing = byRepo.get(file.repo.root);
        if (existing) {
          existing.push(file);
        } else {
          byRepo.set(file.repo.root, [file]);
        }
      }
      // A single repository needs no grouping level.
      if (byRepo.size === 1) {
        return this.files.map((file) => new FileItem(file));
      }
      return [...byRepo.entries()].map(([root, files]) => {
        const name = files[0].repo.name;
        return new RepoItem(root, name, files);
      });
    }

    if (element instanceof RepoItem) {
      return element.files.map((file) => new FileItem(file));
    }
    return [];
  }

  dispose(): void {
    this.changed.dispose();
  }
}
