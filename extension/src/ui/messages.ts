/**
 * The typed protocol between the extension host and the resolver webview.
 *
 * Both sides import this file, so a change to a message shape is a compile
 * error on whichever side has not caught up.
 */

import type { MergeDocument, MergeFormat, Resolution, Side } from "../merge/types";

/** Host → webview. */
export type HostMessage =
  | {
      type: "loaded";
      path: string;
      format: MergeFormat;
      doc: MergeDocument;
      /** Set when the working-tree file has been edited since the merge. */
      manualEdits?: boolean;
    }
  | { type: "preview"; text: string }
  | { type: "counts"; conflictCount: number; unresolvedCount: number }
  | { type: "error"; message: string; canFallBackToText: boolean }
  | { type: "applied"; staged: boolean };

/** Webview → host. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "setResolution"; nodeId: string; resolution: Resolution }
  | { type: "setAll"; side: Side }
  | { type: "apply"; stage: boolean }
  | { type: "openTextEditor" }
  /** Lockfiles only: rebuild the file with the package manager. */
  | { type: "regenerateLockfile" };

/** The subset of the webview API the resolver uses. */
export interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}
