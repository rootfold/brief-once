import path from "node:path";

import type { Diagnostic } from "../../../core/diagnostics/diagnostic.js";
import type { FileSystem } from "../../../core/filesystem/filesystem.js";
import type { GitRepositoryLocator } from "../../../core/git/git-repository-locator.js";
import { loadCanonicalContext } from "../../../core/context/load-context.js";
import { checkAgentFoldServiceAvailability } from "../../service/service-client.js";
import {
  nodeServicePlatformInput,
  type ServicePlatformInput,
} from "../../service/runtime-directory.js";
import type { ConnectorVerificationResult, LaunchDescriptor } from "../connector-types.js";
import { launchAgentFoldMcpWithOfficialClient } from "../mcp-launch-verification.js";
import {
  ConnectorOwnershipStore,
  connectorConfigIdentity,
  connectorRepositoryId,
  type ConnectorInstallationRecord,
} from "../ownership-store.js";
import { resolveConnectorStateDirectory } from "../connector-state-directory.js";
import { antigravityConfigCandidateDefinitions } from "./antigravity-paths.js";
import { fingerprintJsonValue, readAntigravityAgentFoldEntry } from "./antigravity-config.js";
import { antigravityMcpEntrySchema } from "./antigravity-launch-entry.js";
import { antigravityRuleRelativePath, fingerprintAntigravityRule } from "./antigravity-rule.js";
import {
  validateAntigravityHostConfigPath,
  validateAntigravityRuleBoundary,
  validateConnectorStateBoundary,
} from "./antigravity-path-safety.js";

export interface AntigravityMcpLaunchVerification {
  readonly toolsAvailable: number;
}

export interface VerifyAntigravityInput {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly version: string;
  readonly platform?: ServicePlatformInput;
  readonly stateDirectory?: string;
  readonly runtimeDirectory?: string;
  readonly startDirectory?: string;
  readonly resolveDescriptor: () => Promise<LaunchDescriptor>;
  readonly launchMcp?: (
    descriptor: LaunchDescriptor,
    repositoryRoot: string,
  ) => Promise<AntigravityMcpLaunchVerification>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export type AntigravityVerificationOperationResult = ConnectorVerificationResult & {
  readonly exitCode: 0 | 1 | 2 | 6;
};

function diagnostic(
  code: string,
  severity: Diagnostic["severity"],
  message: string,
  suggestion?: string,
): Diagnostic {
  return { code, severity, message, ...(suggestion === undefined ? {} : { suggestion }) };
}

async function launchWithOfficialClient(
  descriptor: LaunchDescriptor,
  repositoryRoot: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<AntigravityMcpLaunchVerification> {
  const result = await launchAgentFoldMcpWithOfficialClient({
    descriptor,
    repositoryRoot,
    environment,
    clientName: "agentfold-antigravity-verifier",
  });
  return { toolsAvailable: result.toolsAvailable };
}

function invalidResult(
  exitCode: 1 | 2 | 6,
  diagnostics: readonly Diagnostic[],
): AntigravityVerificationOperationResult {
  return {
    host: "antigravity",
    valid: false,
    toolsAvailable: 0,
    serviceAvailable: false,
    exitCode,
    diagnostics,
  };
}

export async function verifyAntigravityConnection(
  input: VerifyAntigravityInput,
): Promise<AntigravityVerificationOperationResult> {
  const platform = input.platform ?? nodeServicePlatformInput();
  const context = await loadCanonicalContext({
    fileSystem: input.fileSystem,
    gitRepositoryLocator: input.gitRepositoryLocator,
    ...(input.startDirectory === undefined ? {} : { startDirectory: input.startDirectory }),
  });
  if (context.status === "error") {
    return invalidResult(6, [
      diagnostic(
        "AFCN020",
        "error",
        "Connector verification requires an initialized BriefOnce repository.",
        "Run agentfold init and restore all canonical context files.",
      ),
    ]);
  }
  const stateDirectory = resolveConnectorStateDirectory(platform, input.stateDirectory);
  try {
    await validateConnectorStateBoundary(input.fileSystem, context.repositoryRoot, stateDirectory);
  } catch {
    return invalidResult(1, [
      diagnostic("AFCN004", "error", "Connector state is not safely outside the repository."),
    ]);
  }
  let ownership: ConnectorInstallationRecord | undefined;
  try {
    ownership = await new ConnectorOwnershipStore(input.fileSystem, stateDirectory).read();
  } catch {
    return invalidResult(2, [
      diagnostic(
        "AFCN021",
        "error",
        "The Antigravity connector ownership record is invalid.",
        "Inspect the user-scoped AgentFold compatibility connector state before reconnecting.",
      ),
    ]);
  }
  if (ownership === undefined) {
    return invalidResult(1, [
      diagnostic(
        "AFCN021",
        "error",
        "Antigravity connector ownership is missing.",
        "Run agentfold connect antigravity to preview a safe installation.",
      ),
    ]);
  }
  const repositoryId = connectorRepositoryId(context.repositoryRoot, platform.platform);
  const workspace = ownership.workspaces.find((item) => item.repositoryId === repositoryId);
  if (workspace === undefined) {
    return invalidResult(1, [
      diagnostic(
        "AFCN022",
        "error",
        "This repository is not recorded as connected to Antigravity.",
      ),
    ]);
  }
  const definitions = antigravityConfigCandidateDefinitions(platform, context.repositoryRoot);
  try {
    for (const surface of ownership.surfaces) {
      const candidate = definitions.find(
        (item) =>
          item.scope === "global" &&
          connectorConfigIdentity(item.path, platform.platform) === surface.configIdentity,
      );
      if (candidate === undefined || !(await input.fileSystem.exists(candidate.path))) {
        return invalidResult(1, [
          diagnostic("AFCN023", "error", "A recorded Antigravity MCP configuration is missing."),
        ]);
      }
      await validateAntigravityHostConfigPath(input.fileSystem, candidate.path);
      const entry = readAntigravityAgentFoldEntry(await input.fileSystem.readBytes(candidate.path));
      if (entry === undefined || fingerprintJsonValue(entry) !== surface.entryFingerprint) {
        return invalidResult(1, [
          diagnostic(
            "AFCN024",
            "error",
            "The installed BriefOnce MCP entry differs from its ownership fingerprint.",
            "Review the host configuration manually; verification never rewrites it.",
          ),
        ]);
      }
      antigravityMcpEntrySchema.parse(entry);
    }
    const descriptor = await input.resolveDescriptor();
    if (descriptor.fingerprint !== ownership.executableDescriptorFingerprint) {
      return invalidResult(1, [
        diagnostic(
          "AFCN025",
          "error",
          "The installed BriefOnce executable descriptor is stale.",
          "Preview a connector update after rebuilding or reinstalling BriefOnce.",
        ),
      ]);
    }
    const rulePath = path.join(context.repositoryRoot, ...antigravityRuleRelativePath.split("/"));
    await validateAntigravityRuleBoundary(input.fileSystem, context.repositoryRoot, rulePath);
    if (!(await input.fileSystem.exists(rulePath))) {
      return invalidResult(1, [
        diagnostic("AFCN026", "error", "The BriefOnce workspace rule is missing."),
      ]);
    }
    const rule = await input.fileSystem.readText(rulePath);
    if (fingerprintAntigravityRule(rule) !== workspace.ruleFingerprint) {
      return invalidResult(1, [
        diagnostic(
          "AFCN027",
          "error",
          "The BriefOnce workspace rule was modified after installation.",
        ),
      ]);
    }
    const launched = await (
      input.launchMcp ??
      ((current, root) => launchWithOfficialClient(current, root, input.environment ?? process.env))
    )(descriptor, context.repositoryRoot);
    const service = await checkAgentFoldServiceAvailability({
      fileSystem: input.fileSystem,
      clientVersion: input.version,
      ...(input.runtimeDirectory === undefined ? {} : { runtimeDirectory: input.runtimeDirectory }),
      platform,
    });
    if (!service.available) {
      return invalidResult(6, [
        diagnostic("AFCN028", "error", "Shared-service auto-start verification failed."),
      ]);
    }
    return {
      host: "antigravity",
      valid: true,
      toolsAvailable: launched.toolsAvailable,
      serviceAvailable: true,
      exitCode: 0,
      diagnostics: [
        diagnostic("AFCN029", "success", "Antigravity connector verification passed."),
        diagnostic(
          "AFCN030",
          "info",
          "Host ingestion cannot be verified non-interactively; refresh Installed MCP Servers in Antigravity.",
        ),
      ],
    };
  } catch {
    return invalidResult(1, [
      diagnostic(
        "AFCN031",
        "error",
        "The configured BriefOnce MCP process could not be verified safely.",
        "Inspect the executable, refresh Antigravity MCP servers, and retry verification.",
      ),
    ]);
  }
}
