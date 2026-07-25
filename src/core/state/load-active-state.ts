import type { Diagnostic } from "../diagnostics/diagnostic.js";
import type { FileSystem } from "../filesystem/filesystem.js";
import { isPathInside } from "../context/path-boundary.js";
import {
  preferredProjectDirectory,
  projectStorageAbsolutePath,
  projectStorageRelativePath,
  resolveProjectStorage,
  type ProjectStorageDirectory,
} from "../storage/project-storage.js";
import { ActiveStateParseError, parseActiveState } from "./parse-active-state.js";
import type { ActiveTask } from "./types.js";

export const activeStateRelativePath = ".briefonce/state/current.md";
export const activeStateDirectoryRelativePath = ".briefonce/state/";

export function activeStateRelativePathFor(directory: ProjectStorageDirectory): string {
  return projectStorageRelativePath(directory, "state/current.md");
}

export function activeStateDirectoryRelativePathFor(directory: ProjectStorageDirectory): string {
  return `${projectStorageRelativePath(directory, "state")}/`;
}

interface ActiveStateLocation {
  readonly storageDirectory: ProjectStorageDirectory;
  readonly statePath: string;
  readonly relativePath: string;
  readonly stateDirectoryRelativePath: string;
}

export type ActiveStateLoadResult =
  | (ActiveStateLocation & {
      readonly status: "success";
      readonly state: ActiveTask;
      readonly diagnostics: readonly Diagnostic[];
    })
  | (ActiveStateLocation & {
      readonly status: "missing";
      readonly diagnostics: readonly Diagnostic[];
    })
  | {
      readonly status: "error";
      readonly diagnostics: readonly Diagnostic[];
      readonly storageDirectory?: ProjectStorageDirectory;
      readonly statePath?: string;
      readonly relativePath?: string;
      readonly stateDirectoryRelativePath?: string;
    };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown filesystem error";
}

export async function loadActiveState(
  fileSystem: FileSystem,
  repositoryRoot: string,
  storageDirectory?: ProjectStorageDirectory,
): Promise<ActiveStateLoadResult> {
  let selectedDirectory = storageDirectory;
  if (selectedDirectory === undefined) {
    try {
      const storage = await resolveProjectStorage(fileSystem, repositoryRoot);
      if (storage.status === "conflict") {
        return {
          status: "error",
          diagnostics: [
            {
              code: "AFS011",
              severity: "error",
              message:
                "Both .briefonce and legacy .agentfold project directories exist; active state is ambiguous.",
              suggestion: "Resolve the project-storage conflict before continuing.",
            },
          ],
        };
      }
      selectedDirectory =
        storage.status === "selected" ? storage.selected.directory : preferredProjectDirectory;
    } catch (error: unknown) {
      return {
        status: "error",
        diagnostics: [
          {
            code: "AFS008",
            severity: "error",
            message: `Could not inspect BriefOnce project storage: ${errorMessage(error)}`,
            suggestion: "Check repository permissions and retry.",
          },
        ],
      };
    }
  }

  const statePath = projectStorageAbsolutePath(
    repositoryRoot,
    selectedDirectory,
    "state/current.md",
  );
  const relativePath = activeStateRelativePathFor(selectedDirectory);
  const stateDirectoryRelativePath = activeStateDirectoryRelativePathFor(selectedDirectory);
  const location = {
    storageDirectory: selectedDirectory,
    statePath,
    relativePath,
    stateDirectoryRelativePath,
  } as const;

  try {
    if (!(await fileSystem.exists(statePath))) {
      return { status: "missing", ...location, diagnostics: [] };
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
            message: `${relativePath} resolves outside the Git repository.`,
            suggestion:
              "Replace the escaping symbolic link with a state file inside the repository.",
          },
        ],
      };
    }

    try {
      return {
        status: "success",
        ...location,
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
          message: `Could not load ${relativePath}: ${errorMessage(error)}`,
          suggestion: "Check repository permissions and retry.",
        },
      ],
    };
  }
}
