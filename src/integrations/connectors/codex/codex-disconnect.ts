import path from "node:path";

import type { Diagnostic } from "../../../core/diagnostics/diagnostic.js";
import { AtomicBinaryFileWriter } from "../../../core/filesystem/atomic-binary-file-writer.js";
import { loadCanonicalContext } from "../../../core/context/load-context.js";
import type { ConnectorActionPlan, ConnectorSurface } from "../connector-types.js";
import {
  validateConnectorHostPath,
  validateConnectorStateBoundary,
  validateRepositoryFileBoundary,
} from "../connector-path-safety.js";
import { resolveConnectorStateDirectory } from "../connector-state-directory.js";
import { connectorConfigIdentity } from "../ownership-store.js";
import { restrictConnectorFile } from "../secure-backup.js";
import { nodeServicePlatformInput } from "../../service/runtime-directory.js";
import type { CodexConnectorDependencies } from "./codex-connector.js";
import { prepareCodexAgentsRemoval } from "./codex-agents.js";
import { resolveCodexConfigPath } from "./codex-paths.js";
import {
  CodexOwnershipStore,
  codexInstallationRecordSchema,
  type CodexInstallationRecord,
} from "./codex-ownership.js";
import { prepareCodexTomlRemoval } from "./codex-toml.js";
import { resolveCodexWorktreeIdentity, type CodexWorktreeIdentity } from "./codex-worktree.js";

interface RemovalTarget {
  readonly path: string;
  readonly original: Uint8Array;
  readonly updated: Uint8Array;
}

export interface ReadyCodexDisconnectPlan extends ConnectorActionPlan {
  readonly host: "codex";
  readonly safe: true;
  readonly exitCode: 0;
  readonly repositoryRoot: string;
  readonly stateDirectory: string;
  readonly worktree?: CodexWorktreeIdentity;
  readonly ownership?: CodexInstallationRecord;
  readonly ownershipOriginal?: Uint8Array;
  readonly updatedOwnership?: CodexInstallationRecord;
  readonly configTarget?: RemovalTarget;
  readonly agentsTarget?: RemovalTarget;
}

export interface FailedCodexDisconnectPlan extends ConnectorActionPlan {
  readonly host: "codex";
  readonly safe: false;
  readonly exitCode: 1 | 2 | 4 | 5 | 6;
}

export type CodexDisconnectPlan = ReadyCodexDisconnectPlan | FailedCodexDisconnectPlan;

export interface ApplyCodexDisconnectResult {
  readonly status: "removed" | "failed" | "rollback_failed";
  readonly exitCode: 0 | 1;
  readonly diagnostics: readonly Diagnostic[];
}

function diagnostic(
  code: string,
  severity: Diagnostic["severity"],
  message: string,
  suggestion?: string,
): Diagnostic {
  return { code, severity, message, ...(suggestion === undefined ? {} : { suggestion }) };
}

function failed(
  exitCode: 1 | 2 | 4 | 5 | 6,
  diagnostics: readonly Diagnostic[],
): FailedCodexDisconnectPlan {
  return {
    host: "codex",
    operation: "disconnect",
    safe: false,
    exitCode,
    actions: [],
    diagnostics,
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function prepareCodexDisconnect(
  dependencies: CodexConnectorDependencies,
  requestedSurface: ConnectorSurface = "auto",
): Promise<CodexDisconnectPlan> {
  if (requestedSurface === "desktop") {
    return failed(2, [
      diagnostic("AFCD002", "error", "Codex surfaces are auto, cli, ide, app, and all."),
    ]);
  }
  const platform = dependencies.platform ?? nodeServicePlatformInput();
  const context = await loadCanonicalContext({
    fileSystem: dependencies.fileSystem,
    gitRepositoryLocator: dependencies.gitRepositoryLocator,
  });
  if (context.status === "error") {
    return failed(6, [
      diagnostic("AFCD003", "error", "Disconnect requires an initialized BriefOnce repository."),
    ]);
  }
  const stateDirectory = resolveConnectorStateDirectory(platform, dependencies.stateDirectory);
  try {
    await validateConnectorStateBoundary(
      dependencies.fileSystem,
      context.repositoryRoot,
      stateDirectory,
    );
  } catch {
    return failed(4, [
      diagnostic("AFCD004", "error", "Connector state is not safely outside the repository."),
    ]);
  }
  const store = new CodexOwnershipStore(dependencies.fileSystem, stateDirectory);
  let ownership: CodexInstallationRecord | undefined;
  let ownershipOriginal: Uint8Array | undefined;
  try {
    ownership = await store.read();
    ownershipOriginal =
      ownership === undefined
        ? undefined
        : await dependencies.fileSystem.readBytes(store.recordPath);
  } catch {
    return failed(2, [
      diagnostic("AFCD021", "error", "The Codex connector ownership record is invalid."),
    ]);
  }
  if (ownership === undefined) {
    return {
      host: "codex",
      operation: "disconnect",
      safe: true,
      exitCode: 0,
      actions: [],
      diagnostics: [diagnostic("AFCD050", "info", "Codex connector ownership is already absent.")],
      repositoryRoot: context.repositoryRoot,
      stateDirectory,
    };
  }
  let worktree: CodexWorktreeIdentity;
  try {
    worktree = await resolveCodexWorktreeIdentity({
      fileSystem: dependencies.fileSystem,
      processRunner: dependencies.processRunner,
      repositoryRoot: context.repositoryRoot,
      platform: platform.platform,
    });
  } catch {
    return failed(6, [
      diagnostic("AFCD006", "error", "The Git worktree identity could not be resolved safely."),
    ]);
  }
  const workspace = ownership.workspaces.find(
    (candidate) => candidate.repositoryId === worktree.repositoryId,
  );
  if (workspace === undefined) {
    return {
      host: "codex",
      operation: "disconnect",
      safe: true,
      exitCode: 0,
      actions: [],
      diagnostics: [
        diagnostic("AFCD050", "info", "This worktree is already disconnected from Codex."),
      ],
      repositoryRoot: context.repositoryRoot,
      stateDirectory,
      worktree,
      ownership,
      ...(ownershipOriginal === undefined ? {} : { ownershipOriginal }),
      updatedOwnership: ownership,
    };
  }
  if (
    requestedSurface !== "auto" &&
    requestedSurface !== "all" &&
    !workspace.connections.some((connection) => connection.surface === requestedSurface)
  ) {
    return {
      host: "codex",
      operation: "disconnect",
      safe: true,
      exitCode: 0,
      actions: [],
      diagnostics: [diagnostic("AFCD050", "info", "This Codex surface is already disconnected.")],
      repositoryRoot: context.repositoryRoot,
      stateDirectory,
      worktree,
      ownership,
      ...(ownershipOriginal === undefined ? {} : { ownershipOriginal }),
      updatedOwnership: ownership,
    };
  }
  const selected = new Set(
    requestedSurface === "auto" || requestedSurface === "all"
      ? workspace.connections.map((connection) => connection.surface)
      : [requestedSurface],
  );
  const remainingConnections = workspace.connections.filter(
    (connection) => !selected.has(connection.surface),
  );
  const updatedWorkspaces =
    remainingConnections.length === 0
      ? ownership.workspaces.filter((candidate) => candidate.repositoryId !== worktree.repositoryId)
      : ownership.workspaces.map((candidate) =>
          candidate.repositoryId === worktree.repositoryId
            ? { ...candidate, connections: remainingConnections }
            : candidate,
        );
  const usedConnections = new Set(
    updatedWorkspaces.flatMap((candidate) =>
      candidate.connections.map(
        (connection) => `${connection.configIdentity}:${connection.surface}`,
      ),
    ),
  );
  const updatedSurfaces = ownership.surfaces.filter((surface) =>
    usedConnections.has(`${surface.configIdentity}:${surface.surface}`),
  );
  const configPath = resolveCodexConfigPath(platform, dependencies.codexHome);
  const configIdentity = connectorConfigIdentity(configPath, platform.platform);
  const removedConfigRecords = ownership.surfaces.filter(
    (surface) =>
      surface.configIdentity === configIdentity &&
      !updatedSurfaces.some(
        (remaining) =>
          remaining.configIdentity === surface.configIdentity &&
          remaining.surface === surface.surface,
      ),
  );
  let configTarget: RemovalTarget | undefined;
  if (
    removedConfigRecords.length > 0 &&
    !updatedSurfaces.some((surface) => surface.configIdentity === configIdentity)
  ) {
    const expected = new Set(removedConfigRecords.map((surface) => surface.regionFingerprint));
    if (expected.size !== 1) {
      return failed(1, [
        diagnostic("AFCD051", "error", "Codex configuration ownership is internally inconsistent."),
      ]);
    }
    try {
      await validateConnectorHostPath(dependencies.fileSystem, configPath);
      if (await dependencies.fileSystem.exists(configPath)) {
        const original = await dependencies.fileSystem.readBytes(configPath);
        const removal = prepareCodexTomlRemoval(original, [...expected][0]!);
        if (removal.status === "collision") {
          return failed(5, [
            diagnostic(
              "AFCD052",
              "error",
              removal.reason,
              "The current Codex configuration was preserved.",
            ),
          ]);
        }
        if (removal.changed) configTarget = { path: configPath, original, updated: removal.bytes };
      }
    } catch {
      return failed(2, [
        diagnostic(
          "AFCD053",
          "error",
          "Codex configuration could not be parsed safely for removal.",
        ),
      ]);
    }
  }

  let agentsTarget: RemovalTarget | undefined;
  if (remainingConnections.length === 0) {
    const agentsPath = path.join(context.repositoryRoot, "AGENTS.md");
    try {
      await validateRepositoryFileBoundary(
        dependencies.fileSystem,
        context.repositoryRoot,
        agentsPath,
      );
      if (await dependencies.fileSystem.exists(agentsPath)) {
        const original = await dependencies.fileSystem.readBytes(agentsPath);
        const removal = prepareCodexAgentsRemoval(original, workspace.agentsRegionFingerprint);
        if (removal.status === "collision") {
          return failed(5, [
            diagnostic("AFCD054", "error", removal.reason, "The current AGENTS.md was preserved."),
          ]);
        }
        if (removal.changed) agentsTarget = { path: agentsPath, original, updated: removal.bytes };
      }
    } catch {
      return failed(1, [
        diagnostic("AFCD055", "error", "AGENTS.md could not be inspected safely for removal."),
      ]);
    }
  }
  const updatedOwnership =
    updatedWorkspaces.length === 0 && updatedSurfaces.length === 0
      ? undefined
      : codexInstallationRecordSchema.parse({
          ...ownership,
          workspaces: updatedWorkspaces,
          surfaces: updatedSurfaces,
        });
  return {
    host: "codex",
    operation: "disconnect",
    safe: true,
    exitCode: 0,
    actions: [
      ...(configTarget === undefined
        ? []
        : [
            {
              kind: "remove_entry" as const,
              target: "~/.codex/config.toml",
              description: "Remove only the proven BriefOnce TOML region",
            },
          ]),
      ...(agentsTarget === undefined
        ? []
        : [
            {
              kind: "remove_instructions" as const,
              target: "AGENTS.md",
              description: "Remove only the proven BriefOnce instruction region",
            },
          ]),
      {
        kind: "write_ownership" as const,
        target: "<user-state>/codex-ownership.json",
        description: "Update Codex connector ownership",
      },
    ],
    diagnostics: [
      diagnostic("AFCD056", "success", "A safe Codex disconnect plan was prepared."),
      ...(configTarget === undefined && updatedSurfaces.length > 0
        ? [
            diagnostic(
              "AFCD057",
              "info",
              "The global BriefOnce MCP entry is retained for another connected repository or surface.",
            ),
          ]
        : []),
    ],
    repositoryRoot: context.repositoryRoot,
    stateDirectory,
    worktree,
    ownership,
    ...(ownershipOriginal === undefined ? {} : { ownershipOriginal }),
    ...(updatedOwnership === undefined ? {} : { updatedOwnership }),
    ...(configTarget === undefined ? {} : { configTarget }),
    ...(agentsTarget === undefined ? {} : { agentsTarget }),
  };
}

export async function applyCodexDisconnect(
  plan: ReadyCodexDisconnectPlan,
  dependencies: CodexConnectorDependencies,
): Promise<ApplyCodexDisconnectResult> {
  if (plan.ownership === undefined || plan.ownershipOriginal === undefined) {
    return {
      status: "removed",
      exitCode: 0,
      diagnostics: [diagnostic("AFCD058", "info", "Codex connector content was already absent.")],
    };
  }
  const fileSystem = dependencies.fileSystem;
  const configWriter = new AtomicBinaryFileWriter(fileSystem, undefined, restrictConnectorFile);
  const repositoryWriter = new AtomicBinaryFileWriter(fileSystem);
  const store = new CodexOwnershipStore(fileSystem, plan.stateDirectory);
  let configChanged = false;
  let agentsChanged = false;
  let ownershipChanged = false;
  const rollback = async (): Promise<void> => {
    if (agentsChanged && plan.agentsTarget !== undefined) {
      await repositoryWriter.write(plan.agentsTarget.path, plan.agentsTarget.original, "replace");
    }
    if (configChanged && plan.configTarget !== undefined) {
      await configWriter.write(plan.configTarget.path, plan.configTarget.original, "replace");
    }
    if (ownershipChanged) {
      await configWriter.write(store.recordPath, plan.ownershipOriginal!, "replace");
    }
  };
  try {
    if (
      !(await fileSystem.exists(store.recordPath)) ||
      !equalBytes(await fileSystem.readBytes(store.recordPath), plan.ownershipOriginal)
    ) {
      throw new Error("Codex ownership changed after preview.");
    }
    if (plan.configTarget !== undefined) {
      await validateConnectorHostPath(fileSystem, plan.configTarget.path);
      if (
        !(await fileSystem.exists(plan.configTarget.path)) ||
        !equalBytes(await fileSystem.readBytes(plan.configTarget.path), plan.configTarget.original)
      ) {
        throw new Error("Codex configuration changed after preview.");
      }
      await configWriter.write(plan.configTarget.path, plan.configTarget.updated, "replace");
      configChanged = true;
    }
    if (plan.agentsTarget !== undefined) {
      await validateRepositoryFileBoundary(fileSystem, plan.repositoryRoot, plan.agentsTarget.path);
      if (
        !(await fileSystem.exists(plan.agentsTarget.path)) ||
        !equalBytes(await fileSystem.readBytes(plan.agentsTarget.path), plan.agentsTarget.original)
      ) {
        throw new Error("AGENTS.md changed after preview.");
      }
      await repositoryWriter.write(plan.agentsTarget.path, plan.agentsTarget.updated, "replace");
      agentsChanged = true;
    }
    ownershipChanged = true;
    if (plan.updatedOwnership === undefined) await store.remove();
    else await store.write(plan.updatedOwnership);
    return {
      status: "removed",
      exitCode: 0,
      diagnostics: [
        diagnostic("AFCD058", "success", "The BriefOnce Codex connector was removed safely."),
      ],
    };
  } catch {
    try {
      await rollback();
      return {
        status: "failed",
        exitCode: 1,
        diagnostics: [
          diagnostic(
            "AFCD059",
            "error",
            "Codex disconnect failed and owned changes were rolled back.",
          ),
        ],
      };
    } catch {
      return {
        status: "rollback_failed",
        exitCode: 1,
        diagnostics: [
          diagnostic(
            "AFCD060",
            "error",
            "Codex disconnect rollback failed; the planned files require manual inspection.",
          ),
        ],
      };
    }
  }
}
