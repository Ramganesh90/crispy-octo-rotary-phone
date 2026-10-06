/**
 * Repository discovery.
 *
 * Prefers the built-in `vscode.git` extension so we see the same repositories
 * the user sees in the Source Control view, including ones opened outside the
 * workspace folders. Falls back to asking git directly, which keeps the
 * extension working when the built-in extension is disabled.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";

const exec = promisify(execFile);

/** The slice of the git extension's API that we use. */
interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: { readonly onDidChange: vscode.Event<void> };
}

interface GitApi {
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
}

interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

export interface Repository {
  root: string;
  name: string;
}

function gitApi(): GitApi | undefined {
  const extension =
    vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
  if (!extension?.isActive) {
    return undefined;
  }
  try {
    return extension.exports.getAPI(1);
  } catch {
    return undefined;
  }
}

async function repoRootOf(folder: vscode.Uri): Promise<string | undefined> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], {
      cwd: folder.fsPath,
    });
    const root = stdout.trim();
    return root === "" ? undefined : root;
  } catch {
    return undefined; // not a git repository
  }
}

export async function findRepositories(): Promise<Repository[]> {
  const roots = new Set<string>();

  const api = gitApi();
  if (api) {
    for (const repo of api.repositories) {
      roots.add(repo.rootUri.fsPath);
    }
  }

  // Also probe workspace folders: covers a disabled git extension, and folders
  // that are subdirectories of a repository opened on its own.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = await repoRootOf(folder.uri);
    if (root) {
      roots.add(root);
    }
  }

  return [...roots].sort().map((root) => ({
    root,
    name: root.split(/[\\/]/).pop() || root,
  }));
}

/** Activates the git extension if present, so `findRepositories` can see it. */
export async function activateGitExtension(): Promise<void> {
  const extension = vscode.extensions.getExtension("vscode.git");
  if (extension && !extension.isActive) {
    try {
      await extension.activate();
    } catch {
      // Falling back to the git CLI is fine.
    }
  }
}

/**
 * Fires when any repository's state changes, so the conflict list can
 * refresh after a merge, a stage, or an external git command.
 */
export function onRepositoriesChanged(
  listener: () => void,
  disposables: vscode.Disposable[],
): void {
  const api = gitApi();
  if (!api) {
    return;
  }
  const subscribe = (repo: GitRepository) =>
    disposables.push(repo.state.onDidChange(listener));

  api.repositories.forEach(subscribe);
  disposables.push(
    api.onDidOpenRepository((repo) => {
      subscribe(repo);
      listener();
    }),
    api.onDidCloseRepository(() => listener()),
  );
}
