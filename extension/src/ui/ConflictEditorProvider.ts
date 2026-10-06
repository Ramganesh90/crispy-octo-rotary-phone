/**
 * Hosts the resolver webview for one conflicted file.
 *
 * Registered as a custom *text* editor, so VS Code hands us the working-tree
 * document and we can apply the resolution as a `WorkspaceEdit` — keeping the
 * user's undo history rather than writing the file behind their back.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";

import { analyze, conflictForUri } from "../conflicts";
import { stageResolved } from "../git/stages";
import { regenerateCommand } from "../merge/lockfile";
import {
  countConflicts,
  type MergeDocument,
  type MergeEngine,
  type MergeNode,
  type Side,
  UnsupportedInput,
  walk,
} from "../merge/types";
import type { HostMessage, WebviewMessage } from "./messages";

interface Session {
  engine: MergeEngine;
  doc: MergeDocument;
  repoRoot: string;
  relativePath: string;
}

export class ConflictEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = "structuralMerge.resolver";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onResolved: () => void,
  ) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
    panel.webview.html = this.html(panel.webview);

    let session: Session | undefined;

    const post = (message: HostMessage) => void panel.webview.postMessage(message);

    const load = async (): Promise<void> => {
      const conflict = await conflictForUri(document.uri);
      if (!conflict) {
        post({
          type: "error",
          message:
            "This file has no unresolved merge conflict. It may already be resolved and staged.",
          canFallBackToText: true,
        });
        return;
      }
      if (conflict.format === null || conflict.state.kind === "text") {
        const reason =
          conflict.state.kind === "text" ? conflict.state.reason : "unsupported format";
        post({
          type: "error",
          message: `Cannot resolve this file key by key: ${reason}.`,
          canFallBackToText: true,
        });
        return;
      }

      try {
        const { engine, doc } = await analyze(
          conflict.repo,
          conflict.path,
          conflict.format,
        );
        session = {
          engine,
          doc,
          repoRoot: conflict.repo.root,
          relativePath: conflict.path,
        };
        post({ type: "loaded", path: conflict.path, format: conflict.format, doc });
        post({ type: "preview", text: engine.serialize(doc) });
      } catch (error) {
        post({
          type: "error",
          message:
            error instanceof UnsupportedInput || error instanceof Error
              ? error.message
              : String(error),
          canFallBackToText: true,
        });
      }
    };

    const refreshDerived = (): void => {
      if (!session) {
        return;
      }
      const counts = countConflicts(session.doc.root);
      Object.assign(session.doc, counts);
      post({ type: "counts", ...counts });
      post({ type: "preview", text: session.engine.serialize(session.doc) });
    };

    const apply = async (stage: boolean): Promise<void> => {
      if (!session) {
        return;
      }
      if (session.doc.unresolvedCount > 0) {
        void vscode.window.showWarningMessage(
          `${session.doc.unresolvedCount} conflict(s) still need a decision.`,
        );
        return;
      }

      const text = session.engine.serialize(session.doc);
      const edit = new vscode.WorkspaceEdit();
      const whole = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
      );
      edit.replace(document.uri, whole, text);
      const edited = await vscode.workspace.applyEdit(edit);
      if (!edited) {
        void vscode.window.showErrorMessage("Could not write the resolved file.");
        return;
      }
      await document.save();

      let staged = false;
      if (stage) {
        try {
          await stageResolved(session.repoRoot, session.relativePath);
          staged = true;
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Resolved the file but could not stage it: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      post({ type: "applied", staged });
      this.onResolved();
      void vscode.window.showInformationMessage(
        staged
          ? `Resolved and staged ${session.relativePath}.`
          : `Resolved ${session.relativePath}. Stage it when you are ready.`,
      );
    };

    const setAll = (side: Side): void => {
      if (!session) {
        return;
      }
      for (const node of walk(session.doc.root)) {
        if (!node.children && node.status === "conflict") {
          node.resolution = { kind: "side", side };
        }
      }
      post({ type: "loaded", path: session.relativePath, format: session.doc.format, doc: session.doc });
      refreshDerived();
    };

    /**
     * Rebuilds a lockfile with the package manager. This runs a command in
     * the user's repository, so it always states exactly what it will run and
     * waits for confirmation — never on its own initiative.
     */
    const regenerate = async (): Promise<void> => {
      if (!session) {
        return;
      }
      const { command, args } = regenerateCommand(session.relativePath);
      const line = `${command} ${args.join(" ")}`;

      const choice = await vscode.window.showWarningMessage(
        `Regenerate ${session.relativePath}?`,
        {
          modal: true,
          detail:
            `This runs the following command in ${session.repoRoot}:\n\n    ${line}\n\n` +
            "It rewrites the lockfile from package.json and may change many " +
            "entries. Resolve package.json first if it is also conflicted.",
        },
        "Run",
      );
      if (choice !== "Run") {
        return;
      }

      // Take a side first: npm needs a parseable lockfile on disk.
      session.doc.root[0].resolution = { kind: "side", side: "ours" };
      await apply(false);

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Running ${line}…` },
        async () => {
          try {
            await runCommand(command, args, session!.repoRoot);
            await stageResolved(session!.repoRoot, session!.relativePath);
            this.onResolved();
            void vscode.window.showInformationMessage(
              `Regenerated and staged ${session!.relativePath}.`,
            );
            post({ type: "applied", staged: true });
          } catch (error) {
            void vscode.window.showErrorMessage(
              `${line} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
      );
    };

    panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      switch (message.type) {
        case "ready":
          await load();
          return;
        case "setResolution": {
          if (!session) {
            return;
          }
          const node = findNode(session.doc.root, message.nodeId);
          if (node) {
            node.resolution = message.resolution;
            refreshDerived();
          }
          return;
        }
        case "setAll":
          setAll(message.side);
          return;
        case "apply":
          await apply(message.stage);
          return;
        case "openTextEditor":
          await vscode.commands.executeCommand(
            "vscode.openWith",
            document.uri,
            "default",
          );
          return;
        case "regenerateLockfile":
          await regenerate();
          return;
      }
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = nonceString();
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"),
    );
    const styles = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.css"),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none';
    style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <link href="${styles}" rel="stylesheet">
  <title>Structural Merge Resolver</title>
</head>
<body>
  <div id="root" class="loading">Loading conflict…</div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

const exec = promisify(execFile);

async function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  await exec(command, args, { cwd, maxBuffer: 8 * 1024 * 1024 });
}

function findNode(nodes: MergeNode[], id: string): MergeNode | undefined {
  for (const node of walk(nodes)) {
    if (node.id === id) {
      return node;
    }
  }
  return undefined;
}

function nonceString(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
