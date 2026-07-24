import path from "node:path";

import type { Diagnostic } from "../../../core/diagnostics/diagnostic.js";
import { AtomicBinaryFileWriter } from "../../../core/filesystem/atomic-binary-file-writer.js";
import { AtomicTextFileWriter } from "../../../core/filesystem/atomic-text-file-writer.js";
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
  ConnectorActionPlan,
  ConnectorPlannedAction,
  ConnectorSurface,
  LaunchDescriptor,
} from "../connector-types.js";
import { resolveConnectorStateDirectory } from "../connector-state-directory.js";
import {
  resolveAgentFoldLaunchDescriptor,
  type ResolveLaunchDescriptorInput,
} from "../executable-descriptor.js";
import {
  ConnectorOwnershipStore,
  connectorConfigIdentity,
  connectorRepositoryId,
  connectorInstallationRecordSchema,
  surfaceRecord,
  type ConnectorInstallationRecord,
} from "../ownership-store.js";
import { createSecureConnectorBackup, restrictConnectorFile } from "../secure-backup.js";
import {
  prepareAntigravityConfigEdit,
  type AntigravityConfigEditResult,
  AntigravityConfigSyntaxError,
} from "./antigravity-config.js";
import {
  discoverAntigravity,
  selectAntigravityTargets,
  type AntigravityConfigCandidate,
} from "./antigravity-discovery.js";
import {
  createAntigravityMcpEntry,
  fingerprintAntigravityMcpEntry,
} from "./antigravity-launch-entry.js";
import {
  antigravityContinuityRule,
  antigravityRuleRelativePath,
  prepareAntigravityRule,
  type AntigravityRulePlan,
} from "./antigravity-rule.js";
import {
  validateAntigravityHostConfigPath,
  validateAntigravityRuleBoundary,
  validateConnectorStateBoundary,
} from "./antigravity-path-safety.js";
import {
  verifyAntigravityConnection,
  type AntigravityVerificationOperationResult,
  type VerifyAntigravityInput,
} from "./antigravity-verification.js";

export interface AntigravityConnectorDependencies {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly processRunner: ProcessRunner;
  readonly version: string;
  readonly platform?: ServicePlatformInput;
  readonly stateDirectory?: string;
  readonly runtimeDirectory?: string;
  readonly now?: () => Date;
  readonly executable?: string;
  readonly modulePath?: string;
  readonly allowTemporaryLaunchPath?: boolean;
  readonly generateBackupIdentity?: () => string;
  readonly resolveLaunchDescriptor?: (
    input: ResolveLaunchDescriptorInput,
  ) => Promise<LaunchDescriptor>;
  readonly verifyConnection?: (
    input: VerifyAntigravityInput,
  ) => Promise<AntigravityVerificationOperationResult>;
  readonly launchMcp?: VerifyAntigravityInput["launchMcp"];
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

interface PreparedConfigTarget {
  readonly candidate: AntigravityConfigCandidate;
  readonly surfaces: readonly ("desktop" | "ide" | "cli")[];
  readonly configIdentity: string;
  readonly original?: Uint8Array;
  readonly edit: Extract<AntigravityConfigEditResult, { status: "ready" }>;
}

export interface ReadyAntigravityConnectionPlan extends ConnectorActionPlan {
  readonly safe: true;
  readonly exitCode: 0;
  readonly repositoryRoot: string;
  readonly platform: ServicePlatformInput;
  readonly stateDirectory: string;
  readonly descriptor: LaunchDescriptor;
  readonly configTargets: readonly PreparedConfigTarget[];
  readonly rulePath: string;
  readonly ruleOriginal?: string;
  readonly rulePlan: Extract<AntigravityRulePlan, { status: "ready" }>;
  readonly ownership?: ConnectorInstallationRecord;
  readonly ownershipNeedsUpdate: boolean;
}

export interface FailedAntigravityConnectionPlan extends ConnectorActionPlan {
  readonly safe: false;
  readonly exitCode: 1 | 2 | 4 | 5 | 6;
}

export type AntigravityConnectionPlan =
  ReadyAntigravityConnectionPlan | FailedAntigravityConnectionPlan;

export interface ApplyAntigravityConnectionResult {
  readonly status: "installed" | "failed" | "rollback_failed";
  readonly exitCode: 0 | 1;
  readonly diagnostics: readonly Diagnostic[];
  readonly verification?: AntigravityVerificationOperationResult;
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
): FailedAntigravityConnectionPlan {
  return {
    host: "antigravity",
    operation: "connect",
    safe: false,
    exitCode,
    actions: [],
    diagnostics,
  };
}

function configLabel(
  candidatePath: string,
  homeDirectory: string,
  platform: NodeJS.Platform,
): string {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  const relative = platformPath.relative(homeDirectory, candidatePath);
  if (
    relative !== "" &&
    !relative.startsWith(`..${platformPath.sep}`) &&
    !platformPath.isAbsolute(relative)
  ) {
    return `~/${relative.replaceAll("\\", "/")}`;
  }
  return "<user-config>/mcp_config.json";
}

async function readOwnership(
  store: ConnectorOwnershipStore,
): Promise<ConnectorInstallationRecord | undefined> {
  try {
    return await store.read();
  } catch {
    throw new AntigravityConfigSyntaxError("The connector ownership record is invalid.");
  }
}

export async function prepareAntigravityConnection(
  dependencies: AntigravityConnectorDependencies,
  surface: ConnectorSurface = "auto",
): Promise<AntigravityConnectionPlan> {
  const platform = dependencies.platform ?? nodeServicePlatformInput();
  const context = await loadCanonicalContext({
    fileSystem: dependencies.fileSystem,
    gitRepositoryLocator: dependencies.gitRepositoryLocator,
  });
  if (context.status === "error") {
    return failed(6, [
      diagnostic(
        "AFCN003",
        "error",
        "The current repository is not a complete BriefOnce installation.",
        "Run agentfold doctor and restore canonical context before connecting a host.",
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
      diagnostic(
        "AFCN004",
        "error",
        "Connector state and credential-bearing backups cannot be stored in the repository.",
      ),
    ]);
  }
  const store = new ConnectorOwnershipStore(dependencies.fileSystem, stateDirectory);
  let ownership: ConnectorInstallationRecord | undefined;
  try {
    ownership = await readOwnership(store);
  } catch {
    return failed(2, [
      diagnostic("AFCN021", "error", "The connector ownership record is invalid."),
    ]);
  }
  const discovery = await discoverAntigravity({
    fileSystem: dependencies.fileSystem,
    platform,
    repositoryRoot: context.repositoryRoot,
  });
  const selection = selectAntigravityTargets(discovery, surface);
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
        "AFCN005",
        "error",
        "A stable BriefOnce executable descriptor could not be verified.",
        "Build or reinstall BriefOnce, then retry the preview.",
      ),
    ]);
  }
  const entry = createAntigravityMcpEntry(descriptor);
  const configTargets: PreparedConfigTarget[] = [];
  try {
    for (const target of selection.targets) {
      if (isPathInside(context.repositoryRoot, target.candidate.path)) {
        return failed(4, [
          diagnostic(
            "AFCN004",
            "error",
            "Antigravity user configuration cannot be installed inside the repository.",
          ),
        ]);
      }
      await validateAntigravityHostConfigPath(dependencies.fileSystem, target.candidate.path);
      const original = (await dependencies.fileSystem.exists(target.candidate.path))
        ? await dependencies.fileSystem.readBytes(target.candidate.path)
        : undefined;
      const identity = connectorConfigIdentity(target.candidate.path, platform.platform);
      const proven =
        ownership?.surfaces
          .filter((item) => item.configIdentity === identity)
          .map((item) => item.entryFingerprint) ?? [];
      const edit = prepareAntigravityConfigEdit(original, entry, proven);
      if (edit.status === "collision") {
        return failed(5, [
          diagnostic(
            "AFCN006",
            "error",
            "The Antigravity `agentfold` MCP entry is not proven to be connector-owned.",
            "Rename or remove the conflicting entry manually after reviewing it.",
          ),
        ]);
      }
      configTargets.push({
        candidate: target.candidate,
        surfaces: target.surfaces,
        configIdentity: identity,
        ...(original === undefined ? {} : { original }),
        edit,
      });
    }
  } catch (error: unknown) {
    return failed(error instanceof AntigravityConfigSyntaxError ? 2 : 1, [
      diagnostic(
        "AFCN007",
        "error",
        error instanceof AntigravityConfigSyntaxError
          ? error.message
          : "An Antigravity configuration target could not be inspected safely.",
      ),
    ]);
  }

  const rulePath = path.join(context.repositoryRoot, ...antigravityRuleRelativePath.split("/"));
  let ruleOriginal: string | undefined;
  let rulePlan: AntigravityRulePlan;
  try {
    await validateAntigravityRuleBoundary(
      dependencies.fileSystem,
      context.repositoryRoot,
      rulePath,
    );
    ruleOriginal = (await dependencies.fileSystem.exists(rulePath))
      ? await dependencies.fileSystem.readText(rulePath)
      : undefined;
    const repositoryId = connectorRepositoryId(context.repositoryRoot, platform.platform);
    const provenRule =
      ownership?.workspaces
        .filter((item) => item.repositoryId === repositoryId)
        .map((item) => item.ruleFingerprint) ?? [];
    rulePlan = prepareAntigravityRule(ruleOriginal, provenRule);
  } catch {
    return failed(1, [
      diagnostic("AFCN008", "error", "The workspace rule target is unsafe or unreadable."),
    ]);
  }
  if (rulePlan.status === "collision") {
    return failed(5, [
      diagnostic(
        "AFCN009",
        "error",
        "The BriefOnce continuity-rule path contains user-owned or modified content.",
        "Resolve `.agents/rules/agentfold-continuity.md` manually; it was not overwritten.",
      ),
    ]);
  }

  const actions: ConnectorPlannedAction[] = [];
  for (const target of configTargets) {
    const label = configLabel(target.candidate.path, platform.homeDirectory, platform.platform);
    if (target.original !== undefined && target.edit.action !== "identical") {
      actions.push({
        kind: "create_backup",
        target: label,
        description: "Create an exact secure backup",
      });
    }
    if (target.edit.action !== "identical") {
      actions.push({
        kind: target.original === undefined ? "create_config" : "modify_config",
        target: label,
        description: "Register MCP server `agentfold`",
      });
    }
  }
  if (rulePlan.action !== "identical") {
    actions.push({
      kind: rulePlan.action === "create" ? "create_rule" : "update_rule",
      target: antigravityRuleRelativePath,
      description: "Install the BriefOnce workspace continuity rule",
    });
  }
  const partialPlan = {
    host: "antigravity",
    operation: "connect",
    safe: true,
    exitCode: 0,
    actions,
    diagnostics: [
      diagnostic("AFCN010", "success", "A safe Antigravity connector plan was prepared."),
    ],
    repositoryRoot: context.repositoryRoot,
    platform,
    stateDirectory,
    descriptor,
    configTargets,
    rulePath,
    ...(ruleOriginal === undefined ? {} : { ruleOriginal }),
    rulePlan,
    ...(ownership === undefined ? {} : { ownership }),
  } as const;
  const expectedOwnership = mergeOwnership(
    partialPlan,
    new Map(),
    (dependencies.now ?? (() => new Date()))(),
  );
  const ownershipNeedsUpdate =
    ownership === undefined || JSON.stringify(expectedOwnership) !== JSON.stringify(ownership);
  if (ownershipNeedsUpdate) {
    actions.push({
      kind: "write_ownership",
      target: "<user-state>/antigravity-ownership.json",
      description: "Record connector ownership without configuration content or secrets",
    });
  }
  return { ...partialPlan, actions, ownershipNeedsUpdate };
}

async function prepareStateDirectory(
  fileSystem: FileSystem,
  stateDirectory: string,
  repositoryRoot: string,
): Promise<void> {
  await validateAntigravityHostConfigPath(fileSystem, stateDirectory);
  await fileSystem.ensureDirectory(stateDirectory);
  await validateAntigravityHostConfigPath(fileSystem, stateDirectory);
  const realState = await fileSystem.realPath(stateDirectory);
  const realRepository = await fileSystem.realPath(repositoryRoot);
  if (isPathInside(realRepository, realState)) {
    throw new Error("The connector state directory resolves inside the repository.");
  }
  if (process.platform !== "win32") {
    const { chmod } = await import("node:fs/promises");
    await chmod(stateDirectory, 0o700);
  }
}

function mergeOwnership(
  plan: Omit<ReadyAntigravityConnectionPlan, "ownershipNeedsUpdate">,
  backupIdentities: ReadonlyMap<string, string>,
  now: Date,
): ConnectorInstallationRecord {
  const entryFingerprint = fingerprintAntigravityMcpEntry(
    createAntigravityMcpEntry(plan.descriptor),
  );
  const surfaceRecords = new Map(
    (plan.ownership?.surfaces ?? []).map((item) => [
      `${item.configIdentity}:${item.surface}`,
      item,
    ]),
  );
  for (const target of plan.configTargets) {
    for (const surface of target.surfaces) {
      const key = `${target.configIdentity}:${surface}`;
      const existing = surfaceRecords.get(key);
      const backupIdentity =
        backupIdentities.get(target.configIdentity) ??
        existing?.backupIdentity ??
        plan.ownership?.surfaces.find(
          (item) =>
            item.configIdentity === target.configIdentity && item.backupIdentity !== undefined,
        )?.backupIdentity;
      surfaceRecords.set(
        key,
        surfaceRecord(surface, target.configIdentity, entryFingerprint, backupIdentity),
      );
    }
  }
  const surfaces = [...surfaceRecords.values()].sort(
    (left, right) =>
      left.configIdentity.localeCompare(right.configIdentity) ||
      left.surface.localeCompare(right.surface),
  );
  const repositoryId = connectorRepositoryId(plan.repositoryRoot, plan.platform.platform);
  const connections = new Map(
    (
      plan.ownership?.workspaces.find((item) => item.repositoryId === repositoryId)?.connections ??
      []
    ).map((item) => [`${item.configIdentity}:${item.surface}`, item]),
  );
  for (const target of plan.configTargets) {
    for (const surface of target.surfaces) {
      connections.set(`${target.configIdentity}:${surface}`, {
        surface,
        configIdentity: target.configIdentity,
      });
    }
  }
  const workspaces = [
    ...(plan.ownership?.workspaces.filter((item) => item.repositoryId !== repositoryId) ?? []),
    {
      repositoryId,
      ruleRelativePath: antigravityRuleRelativePath,
      ruleFingerprint: plan.rulePlan.fingerprint,
      connections: [...connections.values()].sort(
        (left, right) =>
          left.configIdentity.localeCompare(right.configIdentity) ||
          left.surface.localeCompare(right.surface),
      ),
    },
  ].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
  return connectorInstallationRecordSchema.parse({
    schemaVersion: 1,
    connector: "antigravity",
    connectorVersion: 1,
    installedAt: plan.ownership?.installedAt ?? now.toISOString(),
    surfaces,
    workspaces,
    executableDescriptorFingerprint: plan.descriptor.fingerprint,
  });
}

export async function applyAntigravityConnection(
  plan: ReadyAntigravityConnectionPlan,
  dependencies: AntigravityConnectorDependencies,
): Promise<ApplyAntigravityConnectionResult> {
  const fileSystem = dependencies.fileSystem;
  const binaryWriter = new AtomicBinaryFileWriter(fileSystem, undefined, restrictConnectorFile);
  const textWriter = new AtomicTextFileWriter(fileSystem);
  const store = new ConnectorOwnershipStore(fileSystem, plan.stateDirectory);
  const ownershipOriginal = (await fileSystem.exists(store.recordPath))
    ? await fileSystem.readBytes(store.recordPath)
    : undefined;
  const backups = new Map<string, string>();
  const changedConfigs: PreparedConfigTarget[] = [];
  let ruleChanged = false;
  let ownershipChanged = false;
  const rollback = async (): Promise<void> => {
    for (const target of [...changedConfigs].reverse()) {
      if (target.original === undefined) await fileSystem.remove(target.candidate.path);
      else await binaryWriter.write(target.candidate.path, target.original, "replace");
    }
    if (ruleChanged) {
      if (plan.ruleOriginal === undefined) await fileSystem.remove(plan.rulePath);
      else await textWriter.write(plan.rulePath, plan.ruleOriginal, "replace");
    }
    if (ownershipChanged) {
      if (ownershipOriginal === undefined) await store.remove();
      else await binaryWriter.write(store.recordPath, ownershipOriginal, "replace");
    }
  };
  try {
    for (const target of plan.configTargets) {
      await validateAntigravityHostConfigPath(fileSystem, target.candidate.path);
      const exists = await fileSystem.exists(target.candidate.path);
      if (target.original === undefined ? exists : !exists) {
        throw new Error("An Antigravity configuration changed after preview.");
      }
      if (
        target.original !== undefined &&
        !equalBytes(await fileSystem.readBytes(target.candidate.path), target.original)
      ) {
        throw new Error("An Antigravity configuration changed after preview.");
      }
    }
    await validateAntigravityRuleBoundary(fileSystem, plan.repositoryRoot, plan.rulePath);
    const ruleExists = await fileSystem.exists(plan.rulePath);
    if (plan.ruleOriginal === undefined ? ruleExists : !ruleExists) {
      throw new Error("The Antigravity workspace rule changed after preview.");
    }
    if (
      plan.ruleOriginal !== undefined &&
      (await fileSystem.readText(plan.rulePath)) !== plan.ruleOriginal
    ) {
      throw new Error("The Antigravity workspace rule changed after preview.");
    }
    await prepareStateDirectory(fileSystem, plan.stateDirectory, plan.repositoryRoot);
    for (const target of plan.configTargets) {
      if (target.original === undefined || target.edit.action === "identical") continue;
      const identity = await createSecureConnectorBackup({
        fileSystem,
        stateDirectory: plan.stateDirectory,
        content: target.original,
        ...(dependencies.generateBackupIdentity === undefined
          ? {}
          : { generateIdentity: dependencies.generateBackupIdentity }),
      });
      backups.set(target.configIdentity, identity);
    }
    for (const target of plan.configTargets) {
      if (target.edit.action === "identical") continue;
      await binaryWriter.write(
        target.candidate.path,
        target.edit.bytes,
        target.original === undefined ? "create" : "replace",
      );
      changedConfigs.push(target);
    }
    if (plan.rulePlan.action !== "identical") {
      await textWriter.write(
        plan.rulePath,
        antigravityContinuityRule,
        plan.ruleOriginal === undefined ? "create" : "replace",
      );
      ruleChanged = true;
    }
    const ownership = mergeOwnership(plan, backups, (dependencies.now ?? (() => new Date()))());
    if (
      plan.ownership === undefined ||
      JSON.stringify(ownership) !== JSON.stringify(plan.ownership)
    ) {
      ownershipChanged = true;
      await store.write(ownership);
    }
    const verification = await (dependencies.verifyConnection ?? verifyAntigravityConnection)({
      fileSystem,
      gitRepositoryLocator: dependencies.gitRepositoryLocator,
      version: dependencies.version,
      platform: plan.platform,
      stateDirectory: plan.stateDirectory,
      ...(dependencies.runtimeDirectory === undefined
        ? {}
        : { runtimeDirectory: dependencies.runtimeDirectory }),
      startDirectory: plan.repositoryRoot,
      resolveDescriptor: () => Promise.resolve(plan.descriptor),
      ...(dependencies.launchMcp === undefined ? {} : { launchMcp: dependencies.launchMcp }),
      ...(dependencies.environment === undefined ? {} : { environment: dependencies.environment }),
    });
    if (!verification.valid) throw new Error("Connector verification failed after installation.");
    return {
      status: "installed",
      exitCode: 0,
      verification,
      diagnostics: [
        diagnostic("AFCN011", "success", "The BriefOnce Antigravity connector was installed."),
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
            "AFCN012",
            "error",
            "Connector installation failed and connector-owned changes were rolled back.",
          ),
        ],
      };
    } catch {
      return {
        status: "rollback_failed",
        exitCode: 1,
        diagnostics: [
          diagnostic(
            "AFCN013",
            "error",
            "Connector installation and rollback both failed; manual inspection is required.",
            "Inspect only the planned Antigravity configuration, workspace rule, and user-scoped ownership record.",
          ),
        ],
      };
    }
  }
}
