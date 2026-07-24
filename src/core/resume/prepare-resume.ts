import path from "node:path";

import { loadLatestCompletedTask } from "../completion/load-completed-task.js";
import { loadCanonicalContext } from "../context/load-context.js";
import { isPathInside } from "../context/path-boundary.js";
import type { Diagnostic } from "../diagnostics/diagnostic.js";
import type { FileSystem } from "../filesystem/filesystem.js";
import type { GitRepositoryLocator } from "../git/git-repository-locator.js";
import {
  checkpointContainsSecretLikeText,
  containsSecretLikeText,
} from "../reports/redact-secrets.js";
import { canonicalContextFailureExitCode } from "../state/context-requirement.js";
import { loadActiveState } from "../state/load-active-state.js";
import { assembleResumePacket } from "./assemble-resume-packet.js";
import { resolveResumeCheckpoint } from "./latest-checkpoint.js";
import { prepareResumeOutputPath } from "./output-path.js";
import { renderResumeJson } from "./render-resume-json.js";
import { renderResumeMarkdown } from "./render-resume-markdown.js";
import { resumeFormatSchema, resumeTargetSchema } from "./resume-packet-schema.js";
import { nativeInstructionFileForTarget } from "./target-instructions.js";
import { truncateResumePacket } from "./truncate-resume-packet.js";
import type { ResumeFormat, ResumePacket, ResumeTarget } from "./types.js";

export interface PrepareResumeDependencies {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly startDirectory?: string;
}

export interface PrepareResumeInput {
  readonly target?: string;
  readonly format?: string;
  readonly checkpoint?: string;
  readonly output?: string;
}

interface BaseResumePlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly exitCode: number;
}

export interface ReadyResumePlan extends BaseResumePlan {
  readonly status: "ready";
  readonly exitCode: 0;
  readonly repositoryRoot: string;
  readonly format: ResumeFormat;
  readonly packet: ResumePacket;
  readonly content: string;
  readonly output?: {
    readonly destination: string;
    readonly relativePath: string;
  };
}

export interface TerminalResumePlan extends BaseResumePlan {
  readonly status:
    | "invalid-option"
    | "invalid-context"
    | "missing-state"
    | "invalid-state"
    | "invalid-checkpoint"
    | "unsafe-content"
    | "unsafe-output"
    | "output-conflict"
    | "filesystem-error";
}

export type ResumePlan = ReadyResumePlan | TerminalResumePlan;

function terminal(
  status: TerminalResumePlan["status"],
  exitCode: number,
  diagnostics: readonly Diagnostic[],
): TerminalResumePlan {
  return { status, exitCode, diagnostics };
}

async function availableNativeInstructionFiles(
  fileSystem: FileSystem,
  repositoryRoot: string,
  target?: ResumeTarget,
): Promise<{ readonly files: readonly string[]; readonly diagnostics: readonly Diagnostic[] }> {
  if (target === undefined) return { files: [], diagnostics: [] };
  const fileName = nativeInstructionFileForTarget(target);
  if (fileName === undefined) return { files: [], diagnostics: [] };
  const candidate = path.join(repositoryRoot, fileName);
  try {
    if ((await fileSystem.entryType(candidate)) !== "file") {
      return { files: [], diagnostics: [] };
    }
    const [realRoot, realCandidate] = await Promise.all([
      fileSystem.realPath(repositoryRoot),
      fileSystem.realPath(candidate),
    ]);
    if (!isPathInside(realRoot, realCandidate)) {
      return {
        files: [],
        diagnostics: [
          {
            code: "AFR024",
            severity: "warning",
            message: `${fileName} resolves outside the repository and was not suggested.`,
            suggestion:
              "Replace the escaping symbolic link with an instruction file inside the repository.",
          },
        ],
      };
    }
    return { files: [fileName], diagnostics: [] };
  } catch {
    return {
      files: [],
      diagnostics: [
        {
          code: "AFR024",
          severity: "warning",
          message: `${fileName} could not be checked safely and was not suggested.`,
        },
      ],
    };
  }
}

function secretFailure(): TerminalResumePlan {
  return terminal("unsafe-content", 4, [
    {
      code: "AFR017",
      severity: "error",
      message: "Secret-like content was found in data selected for the resume packet.",
      suggestion: "Remove or redact the sensitive content before resuming; no value was emitted.",
    },
  ]);
}

export async function prepareResume(
  dependencies: PrepareResumeDependencies,
  input: PrepareResumeInput = {},
): Promise<ResumePlan> {
  const formatResult = resumeFormatSchema.safeParse(input.format ?? "markdown");
  const targetResult =
    input.target === undefined ? undefined : resumeTargetSchema.safeParse(input.target);
  if (!formatResult.success || (targetResult !== undefined && !targetResult.success)) {
    return terminal("invalid-option", 2, [
      {
        code: "AFR023",
        severity: "error",
        message: "The requested resume target or format is unsupported.",
        suggestion: "Use --for codex|antigravity|claude|gemini|generic and --format markdown|json.",
      },
    ]);
  }
  const format = formatResult.data;
  const target = targetResult?.data;

  const contextResult = await loadCanonicalContext({
    fileSystem: dependencies.fileSystem,
    gitRepositoryLocator: dependencies.gitRepositoryLocator,
    ...(dependencies.startDirectory === undefined
      ? {}
      : { startDirectory: dependencies.startDirectory }),
  });
  if (contextResult.status === "error") {
    return terminal(
      "invalid-context",
      canonicalContextFailureExitCode(contextResult),
      contextResult.diagnostics,
    );
  }

  const loadedState = await loadActiveState(dependencies.fileSystem, contextResult.repositoryRoot);
  if (loadedState.status === "missing") {
    const completed = await loadLatestCompletedTask(
      dependencies.fileSystem,
      contextResult.repositoryRoot,
    );
    if (completed.status === "error") {
      return terminal("filesystem-error", 1, completed.diagnostics);
    }
    return terminal("missing-state", 6, [
      {
        code: "AFR002",
        severity: "error",
        message:
          completed.status === "success"
            ? "The previous task is completed. Begin a new task for new implementation work."
            : "No active task exists to resume.",
        suggestion:
          completed.status === "success"
            ? "Run b1 start for the next substantive task; completed tasks are not reopened."
            : "Run b1 start, report progress, and create a checkpoint first.",
      },
    ]);
  }
  if (loadedState.status === "error") {
    return terminal("invalid-state", 2, [
      {
        code: "AFR003",
        severity: "error",
        message: "The active task is invalid and cannot be resumed.",
        suggestion: "Correct the active state; BriefOnce did not modify it.",
      },
      ...loadedState.diagnostics,
    ]);
  }

  const resolvedCheckpoint = await resolveResumeCheckpoint(
    dependencies.fileSystem,
    contextResult.repositoryRoot,
    loadedState.state,
    input.checkpoint,
  );
  if (resolvedCheckpoint.status === "error") {
    return terminal(
      "invalid-checkpoint",
      resolvedCheckpoint.exitCode,
      resolvedCheckpoint.diagnostics,
    );
  }
  if (checkpointContainsSecretLikeText(resolvedCheckpoint.checkpoint)) return secretFailure();

  const nativeFiles = await availableNativeInstructionFiles(
    dependencies.fileSystem,
    contextResult.repositoryRoot,
    target,
  );
  const assembled = assembleResumePacket({
    canonicalContext: contextResult.context,
    activeTask: loadedState.state,
    checkpoint: resolvedCheckpoint.checkpoint,
    isLatestCheckpoint: resolvedCheckpoint.isLatestCheckpoint,
    ...(target === undefined ? {} : { target }),
    availableInstructionFiles: nativeFiles.files,
  });
  if (containsSecretLikeText(JSON.stringify(assembled.packet))) return secretFailure();

  const truncated = truncateResumePacket(assembled.packet);
  const diagnostics: Diagnostic[] = [
    ...contextResult.diagnostics,
    ...resolvedCheckpoint.diagnostics,
    ...nativeFiles.diagnostics,
    ...assembled.diagnostics,
  ];
  if (truncated.packet.semanticState.freshness === "none") {
    diagnostics.push({
      code: "AFR015",
      severity: "warning",
      message: "The selected checkpoint has no semantic report; the packet is Git-only.",
      suggestion: "Verify intent before making broad architectural decisions.",
    });
  } else if (truncated.packet.semanticState.freshness === "reused") {
    diagnostics.push({
      code: "AFR014",
      severity: "info",
      message: `Semantic report revision ${truncated.packet.semanticState.revision} is reused.`,
    });
  }
  if (truncated.truncated) {
    diagnostics.push({
      code: "AFR016",
      severity: "warning",
      message: `Resume content was reduced deterministically: ${truncated.reducedCategories.join(", ")}.`,
      suggestion: "Use the checkpoint and repository as the source of truth for omitted details.",
    });
  }

  const content =
    format === "json" ? renderResumeJson(truncated.packet) : renderResumeMarkdown(truncated.packet);
  let output: ReadyResumePlan["output"];
  if (input.output !== undefined) {
    const outputResult = await prepareResumeOutputPath(
      dependencies.fileSystem,
      contextResult.repositoryRoot,
      input.output,
      format,
    );
    if (outputResult.status === "error") {
      return terminal(
        outputResult.exitCode === 5
          ? "output-conflict"
          : outputResult.exitCode === 2
            ? "unsafe-output"
            : "filesystem-error",
        outputResult.exitCode,
        [...diagnostics, ...outputResult.diagnostics],
      );
    }
    diagnostics.push(...outputResult.diagnostics);
    output = {
      destination: outputResult.destination,
      relativePath: outputResult.relativePath,
    };
  }

  return {
    status: "ready",
    exitCode: 0,
    repositoryRoot: contextResult.repositoryRoot,
    format,
    packet: truncated.packet,
    content,
    ...(output === undefined ? {} : { output }),
    diagnostics,
  };
}
