import { loadCanonicalContext } from "../context/load-context.js";
import type { Diagnostic } from "../diagnostics/diagnostic.js";
import type { AtomicTextFileWriter } from "../filesystem/atomic-text-file-writer.js";
import type { FileSystem } from "../filesystem/filesystem.js";
import type { GitInspector } from "../git/git-inspector.js";
import type { GitRepositoryLocator } from "../git/git-repository-locator.js";
import { canonicalContextFailureExitCode } from "../state/context-requirement.js";
import { loadActiveState } from "../state/load-active-state.js";
import { serializeActiveState } from "../state/serialize-active-state.js";
import { agentNameSchema } from "../state/value-schemas.js";
import { AgentReportValidationError, parseAgentReport } from "./parse-agent-report.js";
import { mergeAgentReport } from "./merge-report.js";
import { redactAgentReport } from "./redact-secrets.js";
import type { AgentReport, ReportMergeSummary } from "./types.js";

interface BaseReportPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly exitCode: number;
  readonly repositoryRoot?: string;
}

export interface ReadyReportPlan extends BaseReportPlan {
  readonly status: "ready";
  readonly exitCode: 0;
  readonly repositoryRoot: string;
  readonly statePath: string;
  readonly taskId: string;
  readonly report: AgentReport;
  readonly summary: ReportMergeSummary;
  readonly redactionCount: number;
  readonly previousRevision: number;
  readonly newRevision: number;
  readonly changed: boolean;
  readonly serializedState: string;
}

export interface TerminalReportPlan extends BaseReportPlan {
  readonly status:
    | "invalid-context"
    | "missing-state"
    | "invalid-state"
    | "invalid-json"
    | "invalid-report"
    | "unsafe-content"
    | "git-error"
    | "filesystem-error";
}

export type ReportPlan = ReadyReportPlan | TerminalReportPlan;

export interface PrepareAgentReportDependencies {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly gitInspector: GitInspector;
  readonly now?: () => Date;
  readonly startDirectory?: string;
}

export interface PrepareAgentReportInput {
  readonly json: string;
  readonly agentOverride?: string;
}

function terminal(
  status: TerminalReportPlan["status"],
  exitCode: number,
  diagnostics: readonly Diagnostic[],
  repositoryRoot?: string,
): TerminalReportPlan {
  return {
    status,
    exitCode,
    ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
    diagnostics,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export async function prepareAgentReport(
  dependencies: PrepareAgentReportDependencies,
  input: PrepareAgentReportInput,
): Promise<ReportPlan> {
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
      contextResult.repositoryRoot,
    );
  }

  const repositoryRoot = contextResult.repositoryRoot;
  const loadedState = await loadActiveState(
    dependencies.fileSystem,
    repositoryRoot,
    contextResult.context.storage.directory,
  );
  if (loadedState.status === "missing") {
    return terminal(
      "missing-state",
      5,
      [
        {
          code: "AFR001",
          severity: "error",
          message: "No active task exists.",
          suggestion: "Run b1 start before submitting a report.",
        },
      ],
      repositoryRoot,
    );
  }

  if (loadedState.status === "error") {
    return terminal("invalid-state", 2, loadedState.diagnostics, repositoryRoot);
  }

  let inputValue: unknown;
  try {
    inputValue = JSON.parse(input.json.replace(/^\uFEFF/u, ""));
  } catch {
    return terminal(
      "invalid-json",
      2,
      [
        {
          code: "AFR002",
          severity: "error",
          message: "Agent report input is not valid JSON.",
          suggestion: "Provide one JSON object through --stdin.",
        },
      ],
      repositoryRoot,
    );
  }

  let report: AgentReport;
  try {
    report = parseAgentReport(inputValue);
    if (input.agentOverride !== undefined) {
      const agentResult = agentNameSchema.safeParse(input.agentOverride);
      if (!agentResult.success) {
        throw new AgentReportValidationError([
          { path: "--agent", message: "Must contain 1 to 100 characters after trimming" },
        ]);
      }
      report = { ...report, agent: agentResult.data };
    }
  } catch (error: unknown) {
    if (error instanceof AgentReportValidationError) {
      return terminal(
        "invalid-report",
        2,
        [
          {
            code: "AFR003",
            severity: "error",
            message: error.message,
            suggestion:
              "Submit concise conclusions and progress only; private reasoning is not stored.",
          },
        ],
        repositoryRoot,
      );
    }
    throw error;
  }

  const redaction = redactAgentReport(report);
  if (!redaction.safe) {
    return terminal(
      "unsafe-content",
      4,
      [
        {
          code: "AFR004",
          severity: "error",
          message: "Secret-like report content could not be safely redacted.",
          suggestion: "Remove the sensitive value and submit the report again.",
        },
      ],
      repositoryRoot,
    );
  }

  try {
    const now = (dependencies.now ?? (() => new Date()))();
    const gitFacts = await dependencies.gitInspector.readWorkingFacts(repositoryRoot);
    const merged = mergeAgentReport(loadedState.state, redaction.value, {
      updatedAt: now.toISOString(),
      gitFacts,
    });
    const diagnostics: Diagnostic[] = [
      ...contextResult.diagnostics,
      {
        code: "AFR005",
        severity: "success",
        message: `Report accepted from ${redaction.value.agent ?? "an unspecified agent"}.`,
      },
    ];
    if (redaction.redactionCount > 0) {
      diagnostics.push({
        code: "AFR006",
        severity: "warning",
        message: `${redaction.redactionCount} secret-like value${redaction.redactionCount === 1 ? " was" : "s were"} redacted before persistence.`,
        suggestion: "Do not include secrets in future agent reports.",
      });
    }

    return {
      status: "ready",
      exitCode: 0,
      repositoryRoot,
      statePath: loadedState.statePath,
      taskId: loadedState.state.taskId,
      report: redaction.value,
      summary: merged.summary,
      redactionCount: redaction.redactionCount,
      previousRevision: loadedState.state.reportRevision,
      newRevision: merged.state.reportRevision,
      changed: merged.state.reportRevision !== loadedState.state.reportRevision,
      serializedState: serializeActiveState(merged.state),
      diagnostics,
    };
  } catch (error: unknown) {
    const gitError = error instanceof Error && error.name === "GitInspectionError";
    return terminal(
      gitError ? "git-error" : "filesystem-error",
      gitError ? 6 : 1,
      [
        {
          code: gitError ? "AFR007" : "AFR008",
          severity: "error",
          message: gitError
            ? "Could not capture the current Git branch and commit."
            : `Could not prepare the report update: ${errorMessage(error)}`,
          suggestion: "The previous active state was not modified.",
        },
      ],
      repositoryRoot,
    );
  }
}

export async function commitAgentReport(
  plan: ReadyReportPlan,
  writer: AtomicTextFileWriter,
): Promise<readonly Diagnostic[]> {
  await writer.write(plan.statePath, plan.serializedState, "replace");

  return [
    ...plan.diagnostics,
    {
      code: "AFR009",
      severity: "success",
      message: `Updated ${plan.statePath.slice(plan.repositoryRoot.length + 1).replaceAll("\\", "/")}`,
    },
  ];
}
