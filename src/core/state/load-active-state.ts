import path from "node:path";

import type { Diagnostic } from "../diagnostics/diagnostic.js";
import type { FileSystem } from "../filesystem/filesystem.js";
import { isPathInside } from "../context/path-boundary.js";
import { ActiveStateParseError, parseActiveState } from "./parse-active-state.js";
import type { ActiveTask } from "./types.js";

export const activeStateRelativePath = ".agentfold/state/current.md";
export const activeStateDirectoryRelativePath = ".agentfold/state/";

export type ActiveStateLoadResult =
  | {
      readonly status: "success";
      readonly state: ActiveTask;
      readonly diagnostics: readonly Diagnostic[];
    }
  | { readonly status: "missing"; readonly diagnostics: readonly Diagnostic[] }
  | { readonly status: "error"; readonly diagnostics: readonly Diagnostic[] };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown filesystem error";
}

export async function loadActiveState(
  fileSystem: FileSystem,
  repositoryRoot: string,
): Promise<ActiveStateLoadResult> {
  const statePath = path.join(repositoryRoot, ".agentfold", "state", "current.md");

  try {
    if (!(await fileSystem.exists(statePath))) {
      return { status: "missing", diagnostics: [] };
    }

    const [realRoot, realStatePath] = await Promise.all([
      fileSystem.realPath(repositoryRoot),
      fileSystem.realPath(statePath),
    ]);
    if (!isPathInside(realRoot, realStatePath)) {
      return {
        status: "error",
        diagnostics: [
          {
            code: "AFS008",
            severity: "error",
            message: `${activeStateRelativePath} resolves outside the Git repository.`,
            suggestion:
              "Replace the escaping symbolic link with a state file inside the repository.",
          },
        ],
      };
    }

    try {
      return {
        status: "success",
        state: parseActiveState(await fileSystem.readText(realStatePath)),
        diagnostics: [],
      };
    } catch (error: unknown) {
      if (error instanceof ActiveStateParseError) {
        return {
          status: "error",
          diagnostics: [
            {
              code: "AFS009",
              severity: "error",
              message: error.message,
              suggestion: "Correct the active state file; BriefOnce did not modify it.",
            },
          ],
        };
      }
      throw error;
    }
  } catch (error: unknown) {
    return {
      status: "error",
      diagnostics: [
        {
          code: "AFS008",
          severity: "error",
          message: `Could not load ${activeStateRelativePath}: ${errorMessage(error)}`,
          suggestion: "Check repository permissions and retry.",
        },
      ],
    };
  }
}
