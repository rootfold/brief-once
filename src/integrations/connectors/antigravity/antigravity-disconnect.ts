import path from "node:path";

import type { Diagnostic } from "../../../core/diagnostics/diagnostic.js";
import { AtomicBinaryFileWriter } from "../../../core/filesystem/atomic-binary-file-writer.js";
import { AtomicTextFileWriter } from "../../../core/filesystem/atomic-text-file-writer.js";
import { loadCanonicalContext } from "../../../core/context/load-context.js";
import type { ConnectorActionPlan, ConnectorSurface } from "../connector-types.js";
import {
  ConnectorOwnershipStore,
  connectorConfigIdentity,
  connectorInstallationRecordSchema,
  connectorRepositoryId,
  type ConnectorInstallationRecord,
} from "../ownership-store.js";
import { resolveConnectorStateDirectory } from "../connector-state-directory.js";
import { restrictConnectorFile } from "../secure-backup.js";
import { nodeServicePlatformInput } from "../../service/runtime-directory.js";
import type { AntigravityConnectorDependencies } from "./antigravity-connector.js";
import {
  validateAntigravityHostConfigPath,
  validateAntigravityRuleBoundary,
  validateConnectorStateBoundary,
} from "./antigravity-path-safety.js";
import { prepareAntigravityConfigRemoval } from "./antigravity-config.js";
import { antigravityConfigCandidateDefinitions } from "./antigravity-paths.js";
import { antigravityRuleRelativePath, fingerprintAntigravityRule } from "./antigravity-rule.js";

interface DisconnectConfigTarget {
  readonly path: string;
  readonly original: Uint8Array;
  readonly updated: Uint8Array;
}

export interface ReadyAntigravityDisconnectPlan extends ConnectorActionPlan {
  readonly safe: true;
  readonly exitCode: 0;
  readonly repositoryRoot: string;
  readonly stateDirectory: string;
  readonly configTargets: readonly DisconnectConfigTarget[];
  readonly rulePath: string;
  readonly removeRule: boolean;
  readonly ruleOriginal?: string;
  readonly ownership: ConnectorInstallationRecord;
  readonly updatedOwnership?: ConnectorInstallationRecord;
}

export interface FailedAntigravityDisconnectPlan extends ConnectorActionPlan {
  readonly safe: false;
  readonly exitCode: 1 | 2 | 4 | 5 | 6;
}

export type AntigravityDisconnectPlan =
  ReadyAntigravityDisconnectPlan | FailedAntigravityDisconnectPlan;

export interface ApplyAntigravityDisconnectResult {
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

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function failed(
  exitCode: 1 | 2 | 4 | 5 | 6,
  diagnostics: readonly Diagnostic[],
): FailedAntigravityDisconnectPlan {
  return {
    host: "antigravity",
    operation: "disconnect",
    safe: false,
    exitCode,
    actions: [],
    diagnostics,
  };
}

export async function prepareAntigravityDisconnect(
  dependencies: AntigravityConnectorDependencies,
  requestedSurface: ConnectorSurface = "auto",
): Promise<AntigravityDisconnectPlan> {
  const platform = dependencies.platform ?? nodeServicePlatformInput();
  const context = await loadCanonicalContext({
    fileSystem: dependencies.fileSystem,
    gitRepositoryLocator: dependencies.gitRepositoryLocator,
  });
  if (context.status === "error") {
    return failed(6, [
      diagnostic("AFCN003", "error", "Disconnect requires an initialized BriefOnce repository."),
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
      diagnostic("AFCN004", "error", "Connector state is not safely outside the repository."),
    ]);
  }
  const store = new ConnectorOwnershipStore(dependencies.fileSystem, stateDirectory);
  let ownership: ConnectorInstallationRecord | undefined;
  try {
    ownership = await store.read();
  } catch {
    return failed(2, [
      diagnostic("AFCN021", "error", "The connector ownership record is invalid."),
    ]);
  }
  if (ownership === undefined) {
    return {
      host: "antigravity",
      operation: "disconnect",
      safe: true,
      exitCode: 0,
      actions: [],
      diagnostics: [
        diagnostic("AFCN032", "info", "Antigravity connector ownership is already absent."),
      ],
      repositoryRoot: context.repositoryRoot,
      stateDirectory,
      configTargets: [],
      rulePath: path.join(context.repositoryRoot, ...antigravityRuleRelativePath.split("/")),
      removeRule: false,
      ownership: connectorInstallationRecordSchema.parse({
        schemaVersion: 1,
        connector: "antigravity",
        connectorVersion: 1,
        installedAt: new Date(0).toISOString(),
        surfaces: [],
        workspaces: [],
        executableDescriptorFingerprint: "0".repeat(64),
      }),
    };
  }
  const repositoryId = connectorRepositoryId(context.repositoryRoot, platform.platform);
  const currentWorkspace = ownership.workspaces.find((item) => item.repositoryId === repositoryId);
  if (currentWorkspace === undefined) {
    return {
      host: "antigravity",
      operation: "disconnect",
      safe: true,
      exitCode: 0,
      actions: [],
      diagnostics: [diagnostic("AFCN032", "info", "This repository is already disconnected.")],
      repositoryRoot: context.repositoryRoot,
      stateDirectory,
      configTargets: [],
      rulePath: path.join(context.repositoryRoot, ...antigravityRuleRelativePath.split("/")),
      removeRule: false,
      ownership,
      updatedOwnership: ownership,
    };
  }
  if (
    requestedSurface !== "auto" &&
    requestedSurface !== "all" &&
    !currentWorkspace.connections.some((item) => item.surface === requestedSurface)
  ) {
    return {
      host: "antigravity",
      operation: "disconnect",
      safe: true,
      exitCode: 0,
      actions: [],
      diagnostics: [
        diagnostic("AFCN032", "info", "This repository surface is already disconnected."),
      ],
      repositoryRoot: context.repositoryRoot,
      stateDirectory,
      configTargets: [],
      rulePath: path.join(context.repositoryRoot, ...antigravityRuleRelativePath.split("/")),
      removeRule: false,
      ownership,
      updatedOwnership: ownership,
    };
  }
  const selected = new Set(
    requestedSurface === "auto" || requestedSurface === "all"
      ? currentWorkspace.connections.map((item) => item.surface)
      : [requestedSurface],
  );
  const remainingForWorkspace = currentWorkspace.connections.filter(
    (connection) => !selected.has(connection.surface),
  );
  const updatedWorkspaces =
    remainingForWorkspace.length === 0
      ? ownership.workspaces.filter((item) => item.repositoryId !== repositoryId)
      : ownership.workspaces.map((item) =>
          item.repositoryId === repositoryId
            ? { ...item, connections: remainingForWorkspace }
            : item,
        );
  const globallyUsedConnections = new Set(
    updatedWorkspaces.flatMap((item) =>
      item.connections.map((connection) => `${connection.configIdentity}:${connection.surface}`),
    ),
  );
  const updatedSurfaces = ownership.surfaces.filter((item) =>
    globallyUsedConnections.has(`${item.configIdentity}:${item.surface}`),
  );
  const retainedConfigIdentities = new Set(updatedSurfaces.map((item) => item.configIdentity));
  const removedConfigRecords = ownership.surfaces.filter(
    (item) => !retainedConfigIdentities.has(item.configIdentity),
  );
  const definitions = antigravityConfigCandidateDefinitions(platform, context.repositoryRoot);
  const configTargets: DisconnectConfigTarget[] = [];
  try {
    for (const identity of new Set(removedConfigRecords.map((item) => item.configIdentity))) {
      const definition = definitions.find(
        (item) =>
          item.scope === "global" &&
          connectorConfigIdentity(item.path, platform.platform) === identity,
      );
      const records = removedConfigRecords.filter((item) => item.configIdentity === identity);
      const expected = new Set(records.map((item) => item.entryFingerprint));
      if (
        definition === undefined ||
        expected.size !== 1 ||
        !(await dependencies.fileSystem.exists(definition.path))
      ) {
        return failed(1, [
          diagnostic(
            "AFCN033",
            "error",
            "Connector ownership is stale for an Antigravity configuration.",
          ),
        ]);
      }
      await validateAntigravityHostConfigPath(dependencies.fileSystem, definition.path);
      const original = await dependencies.fileSystem.readBytes(definition.path);
      const removal = prepareAntigravityConfigRemoval(original, [...expected][0]!);
      if (removal.status === "collision") {
        return failed(5, [
          diagnostic(
            "AFCN034",
            "error",
            "A connector-owned MCP entry was modified and was preserved.",
            "Remove it manually only after reviewing the current host configuration.",
          ),
        ]);
      }
      if (removal.changed)
        configTargets.push({ path: definition.path, original, updated: removal.bytes });
    }
  } catch {
    return failed(2, [
      diagnostic(
        "AFCN035",
        "error",
        "An Antigravity configuration could not be parsed for removal.",
      ),
    ]);
  }

  const removeRule = remainingForWorkspace.length === 0;
  const rulePath = path.join(context.repositoryRoot, ...antigravityRuleRelativePath.split("/"));
  let ruleOriginal: string | undefined;
  try {
    await validateAntigravityRuleBoundary(
      dependencies.fileSystem,
      context.repositoryRoot,
      rulePath,
    );
    if (removeRule && (await dependencies.fileSystem.exists(rulePath))) {
      ruleOriginal = await dependencies.fileSystem.readText(rulePath);
      if (fingerprintAntigravityRule(ruleOriginal) !== currentWorkspace.ruleFingerprint) {
        return failed(5, [
          diagnostic(
            "AFCN036",
            "error",
            "The connector-owned workspace rule was modified and was preserved.",
            "Resolve the rule manually before disconnecting.",
          ),
        ]);
      }
    }
  } catch {
    return failed(1, [diagnostic("AFCN008", "error", "The workspace rule target is unsafe.")]);
  }
  const updatedOwnership =
    updatedWorkspaces.length === 0 && updatedSurfaces.length === 0
      ? undefined
      : connectorInstallationRecordSchema.parse({
          ...ownership,
          surfaces: updatedSurfaces,
          workspaces: updatedWorkspaces,
        });
  return {
    host: "antigravity",
    operation: "disconnect",
    safe: true,
    exitCode: 0,
    actions: [
      ...configTargets.map(() => ({
        kind: "remove_entry" as const,
        target: "<user-config>/mcp_config.json",
        description: "Remove the proven BriefOnce MCP entry and preserve unrelated configuration",
      })),
      ...(removeRule && ruleOriginal !== undefined
        ? [
            {
              kind: "remove_rule" as const,
              target: antigravityRuleRelativePath,
              description: "Remove the proven BriefOnce workspace continuity rule",
            },
          ]
        : []),
      {
        kind: "write_ownership" as const,
        target: "<user-state>/antigravity-ownership.json",
        description: "Update connector ownership",
      },
    ],
    diagnostics: [
      diagnostic("AFCN037", "success", "A safe Antigravity disconnect plan was prepared."),
    ],
    repositoryRoot: context.repositoryRoot,
    stateDirectory,
    configTargets,
    rulePath,
    removeRule,
    ...(ruleOriginal === undefined ? {} : { ruleOriginal }),
    ownership,
    ...(updatedOwnership === undefined ? {} : { updatedOwnership }),
  };
}

export async function applyAntigravityDisconnect(
  plan: ReadyAntigravityDisconnectPlan,
  dependencies: AntigravityConnectorDependencies,
): Promise<ApplyAntigravityDisconnectResult> {
  const fileSystem = dependencies.fileSystem;
  const binaryWriter = new AtomicBinaryFileWriter(fileSystem, undefined, restrictConnectorFile);
  const textWriter = new AtomicTextFileWriter(fileSystem);
  const store = new ConnectorOwnershipStore(fileSystem, plan.stateDirectory);
  const ownershipOriginal = await fileSystem.readBytes(store.recordPath);
  const changedConfigs: DisconnectConfigTarget[] = [];
  let removedRule = false;
  let ownershipChanged = false;
  const rollback = async (): Promise<void> => {
    for (const target of [...changedConfigs].reverse()) {
      await binaryWriter.write(target.path, target.original, "replace");
    }
    if (removedRule && plan.ruleOriginal !== undefined) {
      await textWriter.write(plan.rulePath, plan.ruleOriginal, "create");
    }
    if (ownershipChanged) await binaryWriter.write(store.recordPath, ownershipOriginal, "replace");
  };
  try {
    for (const target of plan.configTargets) {
      await validateAntigravityHostConfigPath(fileSystem, target.path);
      if (
        !(await fileSystem.exists(target.path)) ||
        !equalBytes(await fileSystem.readBytes(target.path), target.original)
      ) {
        throw new Error("An Antigravity configuration changed after preview.");
      }
    }
    await validateAntigravityRuleBoundary(fileSystem, plan.repositoryRoot, plan.rulePath);
    if (
      plan.removeRule &&
      plan.ruleOriginal !== undefined &&
      (!(await fileSystem.exists(plan.rulePath)) ||
        (await fileSystem.readText(plan.rulePath)) !== plan.ruleOriginal)
    ) {
      throw new Error("The Antigravity workspace rule changed after preview.");
    }
    for (const target of plan.configTargets) {
      await binaryWriter.write(target.path, target.updated, "replace");
      changedConfigs.push(target);
    }
    if (plan.removeRule && plan.ruleOriginal !== undefined) {
      await fileSystem.remove(plan.rulePath);
      removedRule = true;
    }
    ownershipChanged = true;
    if (plan.updatedOwnership === undefined) await store.remove();
    else await store.write(plan.updatedOwnership);
    return {
      status: "removed",
      exitCode: 0,
      diagnostics: [
        diagnostic("AFCN038", "success", "The BriefOnce Antigravity connector was removed safely."),
      ],
    };
  } catch {
    try {
      await rollback();
      return {
        status: "failed",
        exitCode: 1,
        diagnostics: [
          diagnostic("AFCN039", "error", "Disconnect failed and owned changes were rolled back."),
        ],
      };
    } catch {
      return {
        status: "rollback_failed",
        exitCode: 1,
        diagnostics: [
          diagnostic(
            "AFCN040",
            "error",
            "Disconnect rollback failed; the planned files require manual inspection.",
          ),
        ],
      };
    }
  }
}
