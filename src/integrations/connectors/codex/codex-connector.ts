import path from "node:path";

import type { Diagnostic } from "../../../core/diagnostics/diagnostic.js";
import { AtomicBinaryFileWriter } from "../../../core/filesystem/atomic-binary-file-writer.js";
import type { FileSystem } from "../../../core/filesystem/filesystem.js";
import type { GitRepositoryLocator } from "../../../core/git/git-repository-locator.js";
import { loadCanonicalContext } from "../../../core/context/load-context.js";
import { isPathInside } from "../../../core/context/path-boundary.js";
import type { ProcessRunner } from "../../../core/process/process-runner.js";
import {
  nodeServicePlatformInput,
  type ServicePlatformInput,
} from "../../service/runtime-directory.js";
import type {
  CodexConcreteConnectorSurface,
  ConnectorActionPlan,
  ConnectorPlannedAction,
  ConnectorSurface,
  LaunchDescriptor,
} from "../connector-types.js";
import {
  validateConnectorHostPath,
  validateConnectorStateBoundary,
  validateRepositoryFileBoundary,
} from "../connector-path-safety.js";
import { resolveConnectorStateDirectory } from "../connector-state-directory.js";
import {
  resolveAgentFoldLaunchDescriptor,
  type ResolveLaunchDescriptorInput,
} from "../executable-descriptor.js";
import { connectorConfigIdentity } from "../ownership-store.js";
import { createSecureConnectorBackup, restrictConnectorFile } from "../secure-backup.js";
import { prepareCodexAgentsEdit, type CodexAgentsEditResult } from "./codex-agents.js";
import { discoverCodex, selectCodexTarget } from "./codex-discovery.js";
import { createCodexMcpEntry } from "./codex-launch-entry.js";
import {
  CodexOwnershipStore,
  codexInstallationRecordSchema,
  type CodexInstallationRecord,
} from "./codex-ownership.js";
import {
  CodexConfigSyntaxError,
  prepareCodexTomlEdit,
  type CodexTomlEditResult,
} from "./codex-toml.js";
import { resolveCodexWorktreeIdentity, type CodexWorktreeIdentity } from "./codex-worktree.js";
import {
  verifyCodexConnection,
  type CodexVerificationOperationResult,
  type VerifyCodexInput,
} from "./codex-verification.js";

export interface CodexConnectorDependencies {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly processRunner: ProcessRunner;
  readonly version: string;
  readonly platform?: ServicePlatformInput;
  readonly stateDirectory?: string;
  readonly runtimeDirectory?: string;
  readonly codexHome?: string;
  readonly now?: () => Date;
  readonly executable?: string;
  readonly modulePath?: string;
  readonly allowTemporaryLaunchPath?: boolean;
  readonly generateBackupIdentity?: () => string;
  readonly resolveLaunchDescriptor?: (
    input: ResolveLaunchDescriptorInput,
  ) => Promise<LaunchDescriptor>;
  readonly verifyConnection?: (
    input: VerifyCodexInput,
  ) => Promise<CodexVerificationOperationResult>;
  readonly launchMcp?: VerifyCodexInput["launchMcp"];
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

interface PreparedConfigTarget {
  readonly path: string;
  readonly configIdentity: string;
  readonly surfaces: readonly CodexConcreteConnectorSurface[];
  readonly original?: Uint8Array;
  readonly edit: Extract<CodexTomlEditResult, { status: "ready" }>;
}

export interface ReadyCodexConnectionPlan extends ConnectorActionPlan {
  readonly host: "codex";
  readonly safe: true;
  readonly exitCode: 0;
  readonly repositoryRoot: string;
  readonly platform: ServicePlatformInput;
  readonly stateDirectory: string;
  readonly descriptor: LaunchDescriptor;
  readonly configTarget: PreparedConfigTarget;
  readonly agentsPath: string;
  readonly agentsOriginal?: Uint8Array;
  readonly agentsEdit: Extract<CodexAgentsEditResult, { status: "ready" }>;
  readonly worktree: CodexWorktreeIdentity;
  readonly ownership?: CodexInstallationRecord;
  readonly ownershipNeedsUpdate: boolean;
}

export interface FailedCodexConnectionPlan extends ConnectorActionPlan {
  readonly host: "codex";
  readonly safe: false;
  readonly exitCode: 1 | 2 | 4 | 5 | 6;
}

export type CodexConnectionPlan = ReadyCodexConnectionPlan | FailedCodexConnectionPlan;

export interface ApplyCodexConnectionResult {
  readonly status: "installed" | "failed" | "rollback_failed";
  readonly exitCode: 0 | 1;
  readonly diagnostics: readonly Diagnostic[];
  readonly verification?: CodexVerificationOperationResult;
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
): FailedCodexConnectionPlan {
  return { host: "codex", operation: "connect", safe: false, exitCode, actions: [], diagnostics };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function prepareStateDirectory(
  fileSystem: FileSystem,
  stateDirectory: string,
  repositoryRoot: string,
): Promise<void> {
  await validateConnectorHostPath(fileSystem, stateDirectory);
  await fileSystem.ensureDirectory(stateDirectory);
  await validateConnectorStateBoundary(fileSystem, repositoryRoot, stateDirectory);
  if (process.platform !== "win32") {
    const { chmod } = await import("node:fs/promises");
    await chmod(stateDirectory, 0o700);
  }
}

function mergeOwnership(
  plan: Omit<ReadyCodexConnectionPlan, "ownershipNeedsUpdate">,
  backupIdentity: string | undefined,
  now: Date,
): CodexInstallationRecord {
  const surfaceRecords = new Map(
    (plan.ownership?.surfaces ?? []).map((surface) => [
      `${surface.configIdentity}:${surface.surface}`,
      surface,
    ]),
  );
  for (const [key, surface] of surfaceRecords) {
    if (surface.configIdentity === plan.configTarget.configIdentity) {
      surfaceRecords.set(key, {
        ...surface,
        regionFingerprint: plan.configTarget.edit.regionFingerprint,
        ...(backupIdentity === undefined ? {} : { backupIdentity }),
      });
    }
  }
  for (const surface of plan.configTarget.surfaces) {
    const key = `${plan.configTarget.configIdentity}:${surface}`;
    const existing = surfaceRecords.get(key);
    const recordBackupIdentity =
      backupIdentity ??
      existing?.backupIdentity ??
      [...surfaceRecords.values()].find(
        (candidate) =>
          candidate.configIdentity === plan.configTarget.configIdentity &&
          candidate.backupIdentity !== undefined,
      )?.backupIdentity;
    surfaceRecords.set(key, {
      surface,
      configIdentity: plan.configTarget.configIdentity,
      serverKey: "agentfold",
      regionFingerprint: plan.configTarget.edit.regionFingerprint,
      ...(recordBackupIdentity === undefined ? {} : { backupIdentity: recordBackupIdentity }),
    });
  }
  const connections = new Map(
    (
      plan.ownership?.workspaces.find(
        (workspace) => workspace.repositoryId === plan.worktree.repositoryId,
      )?.connections ?? []
    ).map((connection) => [`${connection.configIdentity}:${connection.surface}`, connection]),
  );
  for (const surface of plan.configTarget.surfaces) {
    connections.set(`${plan.configTarget.configIdentity}:${surface}`, {
      surface,
      configIdentity: plan.configTarget.configIdentity,
    });
  }
  const workspaces = [
    ...(plan.ownership?.workspaces.filter(
      (workspace) => workspace.repositoryId !== plan.worktree.repositoryId,
    ) ?? []),
    {
      repositoryId: plan.worktree.repositoryId,
      repositoryFamilyId: plan.worktree.repositoryFamilyId,
      worktreeKind: plan.worktree.kind,
      agentsRelativePath: "AGENTS.md" as const,
      agentsRegionFingerprint: plan.agentsEdit.regionFingerprint,
      connections: [...connections.values()].sort(
        (left, right) =>
          left.configIdentity.localeCompare(right.configIdentity) ||
          left.surface.localeCompare(right.surface),
      ),
    },
  ].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
  return codexInstallationRecordSchema.parse({
    schemaVersion: 1,
    connector: "codex",
    connectorVersion: 1,
    installedAt: plan.ownership?.installedAt ?? now.toISOString(),
    surfaces: [...surfaceRecords.values()].sort(
      (left, right) =>
        left.configIdentity.localeCompare(right.configIdentity) ||
        left.surface.localeCompare(right.surface),
    ),
    workspaces,
    executableDescriptorFingerprint: plan.descriptor.fingerprint,
  });
}

export async function prepareCodexConnection(
  dependencies: CodexConnectorDependencies,
  surface: ConnectorSurface = "auto",
): Promise<CodexConnectionPlan> {
  const platform = dependencies.platform ?? nodeServicePlatformInput();
  const context = await loadCanonicalContext({
    fileSystem: dependencies.fileSystem,
    gitRepositoryLocator: dependencies.gitRepositoryLocator,
  });
  if (context.status === "error") {
    return failed(6, [
      diagnostic(
        "AFCD003",
        "error",
        "The current repository is not a complete BriefOnce installation.",
        "Run agentfold doctor and restore canonical context before connecting Codex.",
      ),
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
      diagnostic("AFCD004", "error", "Connector state cannot be stored inside the repository."),
    ]);
  }
  const store = new CodexOwnershipStore(dependencies.fileSystem, stateDirectory);
  let ownership: CodexInstallationRecord | undefined;
  try {
    ownership = await store.read();
  } catch {
    return failed(2, [diagnostic("AFCD005", "error", "The Codex ownership record is invalid.")]);
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
  const discovery = await discoverCodex({
    fileSystem: dependencies.fileSystem,
    platform,
    ...(dependencies.codexHome === undefined ? {} : { codexHome: dependencies.codexHome }),
  });
  const selection = selectCodexTarget(discovery, surface);
  if (selection.status === "error") return failed(selection.exitCode, selection.diagnostics);

  let descriptor: LaunchDescriptor;
  try {
    descriptor = await (dependencies.resolveLaunchDescriptor ?? resolveAgentFoldLaunchDescriptor)({
      fileSystem: dependencies.fileSystem,
      processRunner: dependencies.processRunner,
      ...(dependencies.executable === undefined ? {} : { executable: dependencies.executable }),
      ...(dependencies.modulePath === undefined ? {} : { modulePath: dependencies.modulePath }),
      ...(dependencies.allowTemporaryLaunchPath === undefined
        ? {}
        : { allowTemporaryPath: dependencies.allowTemporaryLaunchPath }),
    });
  } catch {
    return failed(1, [
      diagnostic(
        "AFCD007",
        "error",
        "A stable BriefOnce executable descriptor could not be verified.",
        "Build or reinstall BriefOnce, then retry the preview.",
      ),
    ]);
  }

  const configIdentity = connectorConfigIdentity(selection.configPath, platform.platform);
  let configOriginal: Uint8Array | undefined;
  let configEdit: CodexTomlEditResult;
  try {
    if (isPathInside(context.repositoryRoot, selection.configPath)) {
      return failed(4, [
        diagnostic(
          "AFCD004",
          "error",
          "Codex user configuration cannot be installed inside the repository.",
        ),
      ]);
    }
    await validateConnectorHostPath(dependencies.fileSystem, selection.configPath);
    configOriginal = (await dependencies.fileSystem.exists(selection.configPath))
      ? await dependencies.fileSystem.readBytes(selection.configPath)
      : undefined;
    const proven =
      ownership?.surfaces
        .filter((record) => record.configIdentity === configIdentity)
        .map((record) => record.regionFingerprint) ?? [];
    configEdit = prepareCodexTomlEdit(configOriginal, createCodexMcpEntry(descriptor), proven);
  } catch (error: unknown) {
    return failed(error instanceof CodexConfigSyntaxError ? 2 : 1, [
      diagnostic(
        "AFCD008",
        "error",
        error instanceof CodexConfigSyntaxError
          ? error.message
          : "The Codex user configuration could not be inspected safely.",
      ),
    ]);
  }
  if (configEdit.status === "collision") {
    return failed(5, [
      diagnostic(
        "AFCD009",
        "error",
        configEdit.reason,
        "Review the current entry manually; BriefOnce did not overwrite it.",
      ),
    ]);
  }

  const agentsPath = path.join(context.repositoryRoot, "AGENTS.md");
  let agentsOriginal: Uint8Array | undefined;
  let agentsEdit: CodexAgentsEditResult;
  try {
    await validateRepositoryFileBoundary(
      dependencies.fileSystem,
      context.repositoryRoot,
      agentsPath,
    );
    agentsOriginal = (await dependencies.fileSystem.exists(agentsPath))
      ? await dependencies.fileSystem.readBytes(agentsPath)
      : undefined;
    const proven =
      ownership?.workspaces
        .filter((workspace) => workspace.repositoryId === worktree.repositoryId)
        .map((workspace) => workspace.agentsRegionFingerprint) ?? [];
    agentsEdit = prepareCodexAgentsEdit(agentsOriginal, proven);
  } catch {
    return failed(1, [
      diagnostic("AFCD010", "error", "The repository AGENTS.md target is unsafe or unreadable."),
    ]);
  }
  if (agentsEdit.status === "collision") {
    return failed(5, [
      diagnostic(
        "AFCD011",
        "error",
        agentsEdit.reason,
        "Resolve the managed region manually; it was preserved.",
      ),
    ]);
  }

  const actions: ConnectorPlannedAction[] = [];
  if (configOriginal !== undefined && configEdit.action !== "identical") {
    actions.push({
      kind: "create_backup",
      target: "~/.codex/config.toml",
      description: "Create an exact secure Codex configuration backup",
    });
  }
  if (configEdit.action !== "identical") {
    actions.push({
      kind: configOriginal === undefined ? "create_config" : "modify_config",
      target: "~/.codex/config.toml",
      description: "Register global MCP server `agentfold` in an owned TOML region",
    });
  }
  if (agentsEdit.action !== "identical") {
    actions.push({
      kind: agentsOriginal === undefined ? "create_instructions" : "update_instructions",
      target: "AGENTS.md",
      description: "Install the Codex BriefOnce lifecycle instruction region",
    });
  }
  const partialPlan = {
    host: "codex",
    operation: "connect",
    safe: true,
    exitCode: 0,
    actions,
    diagnostics: [
      diagnostic("AFCD012", "success", "A safe Codex connector plan was prepared."),
      ...(worktree.kind === "linked"
        ? [
            diagnostic(
              "AFCD013",
              "warning",
              "This is a linked worktree; other worktrees do not see its uncommitted changes.",
            ),
          ]
        : []),
    ],
    repositoryRoot: context.repositoryRoot,
    platform,
    stateDirectory,
    descriptor,
    configTarget: {
      path: selection.configPath,
      configIdentity,
      surfaces: selection.surfaces,
      ...(configOriginal === undefined ? {} : { original: configOriginal }),
      edit: configEdit,
    },
    agentsPath,
    ...(agentsOriginal === undefined ? {} : { agentsOriginal }),
    agentsEdit,
    worktree,
    ...(ownership === undefined ? {} : { ownership }),
  } as const;
  const expectedOwnership = mergeOwnership(
    partialPlan,
    undefined,
    (dependencies.now ?? (() => new Date()))(),
  );
  const ownershipNeedsUpdate =
    ownership === undefined || JSON.stringify(expectedOwnership) !== JSON.stringify(ownership);
  if (ownershipNeedsUpdate) {
    actions.push({
      kind: "write_ownership",
      target: "<user-state>/codex-ownership.json",
      description: "Record hashed Codex connector ownership",
    });
  }
  return { ...partialPlan, actions, ownershipNeedsUpdate };
}

export async function applyCodexConnection(
  plan: ReadyCodexConnectionPlan,
  dependencies: CodexConnectorDependencies,
): Promise<ApplyCodexConnectionResult> {
  const fileSystem = dependencies.fileSystem;
  const configWriter = new AtomicBinaryFileWriter(fileSystem, undefined, restrictConnectorFile);
  const repositoryWriter = new AtomicBinaryFileWriter(fileSystem);
  const store = new CodexOwnershipStore(fileSystem, plan.stateDirectory);
  const ownershipOriginal = (await fileSystem.exists(store.recordPath))
    ? await fileSystem.readBytes(store.recordPath)
    : undefined;
  let backupIdentity: string | undefined;
  let configChanged = false;
  let agentsChanged = false;
  let ownershipChanged = false;
  const rollback = async (): Promise<void> => {
    if (agentsChanged) {
      if (plan.agentsOriginal === undefined) await fileSystem.remove(plan.agentsPath);
      else await repositoryWriter.write(plan.agentsPath, plan.agentsOriginal, "replace");
    }
    if (configChanged) {
      if (plan.configTarget.original === undefined) await fileSystem.remove(plan.configTarget.path);
      else await configWriter.write(plan.configTarget.path, plan.configTarget.original, "replace");
    }
    if (ownershipChanged) {
      if (ownershipOriginal === undefined) await store.remove();
      else await configWriter.write(store.recordPath, ownershipOriginal, "replace");
    }
  };
  try {
    await validateConnectorHostPath(fileSystem, plan.configTarget.path);
    const configExists = await fileSystem.exists(plan.configTarget.path);
    if (plan.configTarget.original === undefined ? configExists : !configExists) {
      throw new Error("The Codex configuration changed after preview.");
    }
    if (
      plan.configTarget.original !== undefined &&
      !equalBytes(await fileSystem.readBytes(plan.configTarget.path), plan.configTarget.original)
    ) {
      throw new Error("The Codex configuration changed after preview.");
    }
    await validateRepositoryFileBoundary(fileSystem, plan.repositoryRoot, plan.agentsPath);
    const agentsExists = await fileSystem.exists(plan.agentsPath);
    if (plan.agentsOriginal === undefined ? agentsExists : !agentsExists) {
      throw new Error("AGENTS.md changed after preview.");
    }
    if (
      plan.agentsOriginal !== undefined &&
      !equalBytes(await fileSystem.readBytes(plan.agentsPath), plan.agentsOriginal)
    ) {
      throw new Error("AGENTS.md changed after preview.");
    }
    await prepareStateDirectory(fileSystem, plan.stateDirectory, plan.repositoryRoot);
    if (plan.configTarget.original !== undefined && plan.configTarget.edit.action !== "identical") {
      backupIdentity = await createSecureConnectorBackup({
        fileSystem,
        stateDirectory: plan.stateDirectory,
        content: plan.configTarget.original,
        ...(dependencies.generateBackupIdentity === undefined
          ? {}
          : { generateIdentity: dependencies.generateBackupIdentity }),
      });
    }
    if (plan.configTarget.edit.action !== "identical") {
      await configWriter.write(
        plan.configTarget.path,
        plan.configTarget.edit.bytes,
        plan.configTarget.original === undefined ? "create" : "replace",
      );
      configChanged = true;
    }
    if (plan.agentsEdit.action !== "identical") {
      await repositoryWriter.write(
        plan.agentsPath,
        plan.agentsEdit.bytes,
        plan.agentsOriginal === undefined ? "create" : "replace",
      );
      agentsChanged = true;
    }
    const ownership = mergeOwnership(
      plan,
      backupIdentity,
      (dependencies.now ?? (() => new Date()))(),
    );
    if (
      plan.ownership === undefined ||
      JSON.stringify(ownership) !== JSON.stringify(plan.ownership)
    ) {
      ownershipChanged = true;
      await store.write(ownership);
    }
    const verification = await (dependencies.verifyConnection ?? verifyCodexConnection)({
      fileSystem,
      gitRepositoryLocator: dependencies.gitRepositoryLocator,
      processRunner: dependencies.processRunner,
      version: dependencies.version,
      platform: plan.platform,
      stateDirectory: plan.stateDirectory,
      ...(dependencies.runtimeDirectory === undefined
        ? {}
        : { runtimeDirectory: dependencies.runtimeDirectory }),
      ...(dependencies.codexHome === undefined ? {} : { codexHome: dependencies.codexHome }),
      startDirectory: plan.repositoryRoot,
      resolveDescriptor: () => Promise.resolve(plan.descriptor),
      ...(dependencies.launchMcp === undefined ? {} : { launchMcp: dependencies.launchMcp }),
      ...(dependencies.environment === undefined ? {} : { environment: dependencies.environment }),
    });
    if (!verification.valid)
      throw new Error("Codex connector verification failed after installation.");
    return {
      status: "installed",
      exitCode: 0,
      verification,
      diagnostics: [
        diagnostic("AFCD014", "success", "The BriefOnce Codex connector was installed."),
        ...verification.diagnostics,
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
            "AFCD015",
            "error",
            "Codex installation failed and connector-owned changes were rolled back.",
          ),
        ],
      };
    } catch {
      return {
        status: "rollback_failed",
        exitCode: 1,
        diagnostics: [
          diagnostic(
            "AFCD016",
            "error",
            "Codex installation and rollback both failed; manual inspection is required.",
            "Inspect only the planned Codex config, AGENTS.md region, and Codex ownership record.",
          ),
        ],
      };
    }
  }
}
