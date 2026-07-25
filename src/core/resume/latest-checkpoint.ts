import path from "node:path";

import { checkpointSequenceFromFileName } from "../checkpoints/checkpoint-id.js";
import { CheckpointParseError, parseCheckpoint } from "../checkpoints/parse-checkpoint.js";
import type { Checkpoint } from "../checkpoints/types.js";
import { isPathInside } from "../context/path-boundary.js";
import type { Diagnostic } from "../diagnostics/diagnostic.js";
import type { FileSystem } from "../filesystem/filesystem.js";
import type { ActiveTask } from "../state/types.js";
import {
  preferredProjectDirectory,
  projectStorageAbsolutePath,
  type ProjectStorageDirectory,
} from "../storage/project-storage.js";

export const resumeHistoryRelativePath = ".briefonce/state/history";

export interface ResolvedResumeCheckpoint {
  readonly status: "success";
  readonly checkpoint: Checkpoint;
  readonly checkpointId: string;
  readonly latestCheckpointId: string;
  readonly isLatestCheckpoint: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ResumeCheckpointFailure {
  readonly status: "error";
  readonly exitCode: 1 | 2 | 6;
  readonly diagnostics: readonly Diagnostic[];
}

export type ResolveResumeCheckpointResult = ResolvedResumeCheckpoint | ResumeCheckpointFailure;

interface HistoryDirectory {
  readonly lexicalPath: string;
  readonly realPath: string;
  readonly entries: readonly string[];
}

function failure(
  exitCode: ResumeCheckpointFailure["exitCode"],
  code: string,
  message: string,
  suggestion: string,
): ResumeCheckpointFailure {
  return {
    status: "error",
    exitCode,
    diagnostics: [{ code, severity: "error", message, suggestion }],
  };
}

async function loadHistoryDirectory(
  fileSystem: FileSystem,
  repositoryRoot: string,
  storageDirectory: ProjectStorageDirectory,
): Promise<HistoryDirectory | undefined> {
  const lexicalPath = projectStorageAbsolutePath(repositoryRoot, storageDirectory, "state/history");
  const entryType = await fileSystem.entryType(lexicalPath);
  if (entryType === undefined) return undefined;
  if (entryType !== "directory") throw new Error("Checkpoint history is not a directory");
  const [realRoot, realPath] = await Promise.all([
    fileSystem.realPath(repositoryRoot),
    fileSystem.realPath(lexicalPath),
  ]);
  if (!isPathInside(realRoot, realPath)) {
    throw new Error("Checkpoint history resolves outside the repository");
  }
  return { lexicalPath, realPath, entries: await fileSystem.listDirectory(realPath) };
}

function highestCheckpointId(taskId: string, entries: readonly string[]): string | undefined {
  const sequence = Math.max(
    0,
    ...entries.map((entry) => checkpointSequenceFromFileName(taskId, entry) ?? 0),
  );
  return sequence === 0 ? undefined : `CP-${sequence.toString().padStart(3, "0")}`;
}

function requestedCheckpointId(
  taskId: string,
  requested: string,
): { readonly success: true; readonly checkpointId: string } | ResumeCheckpointFailure {
  if (
    requested.length === 0 ||
    path.isAbsolute(requested) ||
    requested.includes("/") ||
    requested.includes("\\") ||
    requested.includes("..") ||
    requested.includes(":")
  ) {
    return failure(
      2,
      "AFR007",
      "The requested checkpoint identifier is unsafe.",
      "Use CP-NNN or the complete active-task checkpoint identity.",
    );
  }
  if (/^CP-\d{3}$/u.test(requested)) return { success: true, checkpointId: requested };
  const complete = requested.match(/^(AF-\d{8}-\d{3})-(CP-\d{3})$/u);
  if (complete === null) {
    return failure(
      2,
      "AFR007",
      "The requested checkpoint identifier is malformed.",
      "Use CP-NNN or AF-YYYYMMDD-NNN-CP-NNN.",
    );
  }
  if (complete[1] !== taskId) {
    return failure(
      2,
      "AFR008",
      "The requested checkpoint belongs to a different task.",
      "Select a checkpoint for the active task.",
    );
  }
  return { success: true, checkpointId: complete[2] ?? "" };
}

export async function resolveResumeCheckpoint(
  fileSystem: FileSystem,
  repositoryRoot: string,
  activeTask: ActiveTask,
  requested?: string,
  storageDirectory: ProjectStorageDirectory = preferredProjectDirectory,
): Promise<ResolveResumeCheckpointResult> {
  try {
    const history = await loadHistoryDirectory(fileSystem, repositoryRoot, storageDirectory);
    if (history === undefined) {
      return failure(
        6,
        "AFR004",
        "No immutable checkpoint history exists for the active task.",
        "Run b1 checkpoint before resuming.",
      );
    }

    const fallbackLatestId = highestCheckpointId(activeTask.taskId, history.entries);
    const metadataLatestId = activeTask.checkpointHistory.latestCheckpointId;
    const diagnostics: Diagnostic[] = [];
    let latestCheckpointId = metadataLatestId;
    if (latestCheckpointId === null) {
      if (fallbackLatestId === undefined) {
        return failure(
          6,
          "AFR004",
          "No immutable checkpoint exists for the active task.",
          "Run b1 checkpoint before resuming.",
        );
      }
      latestCheckpointId = fallbackLatestId;
      diagnostics.push({
        code: "AFR009",
        severity: "warning",
        message:
          "Active-state checkpoint metadata was incomplete; the highest valid task checkpoint filename was selected.",
        suggestion: "The active state was not repaired or rewritten.",
      });
    }

    let checkpointId = latestCheckpointId;
    if (requested !== undefined) {
      const parsed = requestedCheckpointId(activeTask.taskId, requested.trim());
      if (!("success" in parsed)) return parsed;
      checkpointId = parsed.checkpointId;
    }
    const fileName = `${activeTask.taskId}-${checkpointId}.md`;
    const candidate = path.join(history.lexicalPath, fileName);
    if ((await fileSystem.entryType(candidate)) !== "file") {
      return failure(
        6,
        requested === undefined ? "AFR005" : "AFR006",
        requested === undefined
          ? "The checkpoint referenced by active state is missing."
          : "The requested checkpoint does not exist for the active task.",
        "Create or select a valid immutable checkpoint; no state was modified.",
      );
    }
    const realCandidate = await fileSystem.realPath(candidate);
    if (!isPathInside(history.realPath, realCandidate)) {
      return failure(
        2,
        "AFR007",
        "The selected checkpoint resolves outside checkpoint history.",
        "Replace the escaping symbolic link with an immutable history file.",
      );
    }

    const checkpointContent = await fileSystem.readText(realCandidate);
    let checkpoint: Checkpoint;
    try {
      checkpoint = parseCheckpoint(checkpointContent, activeTask.taskId);
    } catch (error: unknown) {
      const fingerprintFailure =
        error instanceof CheckpointParseError &&
        error.issues.some((issue) => issue.path === "fingerprint");
      const taskMismatch =
        error instanceof CheckpointParseError &&
        error.issues.some((issue) => issue.path === "task_id");
      return failure(
        2,
        fingerprintFailure ? "AFR011" : taskMismatch ? "AFR008" : "AFR010",
        fingerprintFailure
          ? "The selected checkpoint fingerprint is invalid."
          : taskMismatch
            ? "The selected checkpoint belongs to a different task."
            : "The selected checkpoint is invalid or corrupt.",
        "Inspect or recreate the checkpoint safely; BriefOnce did not repair it.",
      );
    }
    if (checkpoint.checkpointId !== checkpointId) {
      return failure(
        2,
        "AFR008",
        "The checkpoint file identity does not match its validated contents.",
        "Select or recreate a checkpoint with matching immutable identity.",
      );
    }
    if (
      checkpointId === metadataLatestId &&
      activeTask.checkpointHistory.latestFingerprint !== null &&
      checkpoint.fingerprint !== activeTask.checkpointHistory.latestFingerprint
    ) {
      return failure(
        2,
        "AFR008",
        "Active-state metadata does not match the referenced checkpoint fingerprint.",
        "Inspect the active state and immutable history; nothing was modified.",
      );
    }

    const isLatestCheckpoint = checkpointId === latestCheckpointId;
    if (!isLatestCheckpoint) {
      diagnostics.push({
        code: "AFR013",
        severity: "warning",
        message: `Historical checkpoint ${checkpointId} was selected; ${latestCheckpointId} is latest.`,
      });
    }
    return {
      status: "success",
      checkpoint,
      checkpointId,
      latestCheckpointId,
      isLatestCheckpoint,
      diagnostics,
    };
  } catch {
    return failure(
      1,
      "AFR018",
      "Checkpoint history could not be resolved safely.",
      "Check repository permissions and checkpoint-history paths, then retry.",
    );
  }
}
