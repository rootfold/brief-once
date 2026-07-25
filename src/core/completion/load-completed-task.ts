import path from "node:path";

import { isPathInside } from "../context/path-boundary.js";
import type { Diagnostic } from "../diagnostics/diagnostic.js";
import type { FileSystem } from "../filesystem/filesystem.js";
import {
  preferredProjectDirectory,
  projectStorageAbsolutePath,
  projectStorageRelativePath,
  type ProjectStorageDirectory,
} from "../storage/project-storage.js";
import { CompletedTaskParseError, parseCompletedTask } from "./parse-completed-task.js";
import type { CompletedTask } from "./types.js";

export const completedTasksRelativePath = ".briefonce/state/completed";

export function completedTasksRelativePathFor(directory: ProjectStorageDirectory): string {
  return projectStorageRelativePath(directory, "state/completed");
}

export type LatestCompletedTaskLoadResult =
  | { readonly status: "success"; readonly task: CompletedTask }
  | { readonly status: "missing" }
  | { readonly status: "error"; readonly diagnostics: readonly Diagnostic[] };

export async function loadLatestCompletedTask(
  fileSystem: FileSystem,
  repositoryRoot: string,
  storageDirectory: ProjectStorageDirectory = preferredProjectDirectory,
): Promise<LatestCompletedTaskLoadResult> {
  const relativeDirectory = completedTasksRelativePathFor(storageDirectory);
  const directory = projectStorageAbsolutePath(repositoryRoot, storageDirectory, "state/completed");
  try {
    const entryType = await fileSystem.entryType(directory);
    if (entryType === undefined) return { status: "missing" };
    if (entryType !== "directory") throw new Error("Completed-task path is not a directory.");
    const [realRoot, realDirectory] = await Promise.all([
      fileSystem.realPath(repositoryRoot),
      fileSystem.realPath(directory),
    ]);
    if (!isPathInside(realRoot, realDirectory)) {
      throw new Error("Completed-task directory resolves outside the Git repository.");
    }
    const tasks: CompletedTask[] = [];
    for (const entry of await fileSystem.listDirectory(realDirectory)) {
      const match = /^(AF-\d{8}-\d{3})\.md$/u.exec(entry);
      if (match === null) continue;
      const filePath = path.join(realDirectory, entry);
      if ((await fileSystem.entryType(filePath)) !== "file") continue;
      tasks.push(parseCompletedTask(await fileSystem.readText(filePath), match[1]));
    }
    const latest = tasks.sort((left, right) => {
      const timestamp = right.finishedAt.localeCompare(left.finishedAt);
      return timestamp === 0 ? right.taskId.localeCompare(left.taskId) : timestamp;
    })[0];
    return latest === undefined ? { status: "missing" } : { status: "success", task: latest };
  } catch (error: unknown) {
    return {
      status: "error",
      diagnostics: [
        {
          code: "AFF030",
          severity: "error",
          message:
            error instanceof CompletedTaskParseError
              ? error.message
              : "Completed-task history could not be inspected safely.",
          suggestion: `Review ${relativeDirectory}; BriefOnce did not modify it.`,
        },
      ],
    };
  }
}
