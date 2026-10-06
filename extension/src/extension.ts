import * as vscode from "vscode";

import { analyze, type ConflictFile, conflictForUri } from "./conflicts";
import { activateGitExtension, onRepositoriesChanged } from "./git/repo";
import { stageResolved } from "./git/stages";
import { ConflictEditorProvider } from "./ui/ConflictEditorProvider";
import { ConflictTreeProvider } from "./ui/ConflictTreeProvider";

/**
 * Offers the resolver from the top of a conflicted file, so a developer who
 * opened the file the usual way still finds the feature.
 */
class ResolveCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  refresh(): void {
    this.changed.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!vscode.workspace.getConfiguration("structuralMerge").get("showCodeLens", true)) {
      return [];
    }
    const conflict = await conflictForUri(document.uri);
    if (!conflict || conflict.state.kind === "text") {
      return [];
    }

    const title =
      conflict.state.kind === "structural"
        ? `$(git-merge) Resolve ${conflict.state.conflictCount} conflict${
            conflict.state.conflictCount === 1 ? "" : "s"
          } key by key`
        : "$(check) Merges cleanly — review and apply";

    return [
      new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title,
        command: "structuralMerge.resolve",
        arguments: [conflict],
      }),
    ];
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/** Resolves the argument a command was invoked with into a conflict record. */
async function conflictFromArgument(argument: unknown): Promise<ConflictFile | undefined> {
  if (argument && typeof argument === "object" && "repo" in argument && "path" in argument) {
    return argument as ConflictFile;
  }
  // From the SCM view the argument is a resource state; from the editor title
  // there is no argument and the active editor is the subject.
  const uri =
    argument instanceof vscode.Uri
      ? argument
      : argument && typeof argument === "object" && "resourceUri" in argument
        ? ((argument as { resourceUri: vscode.Uri }).resourceUri)
        : vscode.window.activeTextEditor?.document.uri;
  return uri ? conflictForUri(uri) : undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await activateGitExtension();

  const tree = new ConflictTreeProvider();
  const codeLens = new ResolveCodeLensProvider();

  const refresh = () => {
    tree.refresh();
    codeLens.refresh();
    void updateActiveFileContext();
  };

  const view = vscode.window.createTreeView("structuralMerge.conflicts", {
    treeDataProvider: tree,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    view,
    tree,
    codeLens,
    vscode.window.registerCustomEditorProvider(
      ConflictEditorProvider.viewType,
      new ConflictEditorProvider(context, refresh),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false },
    ),
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, codeLens),
  );

  // --- commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand("structuralMerge.refresh", refresh),

    vscode.commands.registerCommand("structuralMerge.resolve", async (argument?: unknown) => {
      const conflict = await conflictFromArgument(argument);
      if (!conflict) {
        void vscode.window.showInformationMessage(
          "No merge conflict found for this file.",
        );
        return;
      }
      await vscode.commands.executeCommand(
        "vscode.openWith",
        conflict.uri,
        ConflictEditorProvider.viewType,
      );
    }),

    vscode.commands.registerCommand(
      "structuralMerge.openInTextEditor",
      async (argument?: unknown) => {
        const conflict = await conflictFromArgument(argument);
        const uri = conflict?.uri ?? vscode.window.activeTextEditor?.document.uri;
        if (uri) {
          await vscode.commands.executeCommand("vscode.openWith", uri, "default");
        }
      },
    ),

    vscode.commands.registerCommand("structuralMerge.resolveAllClean", async () => {
      const clean = tree.conflicts.filter((c) => c.state.kind === "clean");
      if (clean.length === 0) {
        void vscode.window.showInformationMessage(
          "No conflicted files merge cleanly on their own.",
        );
        return;
      }

      const choice = await vscode.window.showWarningMessage(
        `Resolve and stage ${clean.length} file${clean.length === 1 ? "" : "s"} that merge cleanly?`,
        { modal: true, detail: clean.map((c) => c.path).join("\n") },
        "Resolve",
      );
      if (choice !== "Resolve") {
        return;
      }

      const failures: string[] = [];
      for (const file of clean) {
        try {
          const { engine, doc } = await analyze(file.repo, file.path, file.format!);
          const text = engine.serialize(doc);
          await vscode.workspace.fs.writeFile(file.uri, Buffer.from(text, "utf8"));
          await stageResolved(file.repo.root, file.path);
        } catch (error) {
          failures.push(
            `${file.path}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      refresh();
      if (failures.length > 0) {
        void vscode.window.showErrorMessage(
          `Resolved ${clean.length - failures.length} of ${clean.length} files.`,
          { modal: true, detail: failures.join("\n") },
        );
      } else {
        void vscode.window.showInformationMessage(
          `Resolved and staged ${clean.length} file${clean.length === 1 ? "" : "s"}.`,
        );
      }
    }),
  );

  // --- refresh triggers ---

  async function updateActiveFileContext(): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const conflict = uri ? await conflictForUri(uri) : undefined;
    await vscode.commands.executeCommand(
      "setContext",
      "structuralMerge.activeFileConflicted",
      conflict !== undefined && conflict.state.kind !== "text",
    );
  }

  onRepositoriesChanged(refresh, context.subscriptions);

  // The git extension's events cover most changes; watching the index catches
  // merges driven from an external terminal.
  const indexWatcher = vscode.workspace.createFileSystemWatcher("**/.git/index");
  context.subscriptions.push(
    indexWatcher,
    indexWatcher.onDidChange(refresh),
    indexWatcher.onDidCreate(refresh),
    indexWatcher.onDidDelete(refresh),
    vscode.window.onDidChangeActiveTextEditor(() => void updateActiveFileContext()),
  );

  refresh();
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
