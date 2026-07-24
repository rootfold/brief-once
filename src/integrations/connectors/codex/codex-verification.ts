import path from "node:path";

import type { Diagnostic } from "../../../core/diagnostics/diagnostic.js";
import type { FileSystem } from "../../../core/filesystem/filesystem.js";
import type { GitRepositoryLocator } from "../../../core/git/git-repository-locator.js";
import { loadCanonicalContext } from "../../../core/context/load-context.js";
import type { ProcessRunner } from "../../../core/process/process-runner.js";
import { checkAgentFoldServiceAvailability } from "../../service/service-client.js";
import {
  nodeServicePlatformInput,
  type ServicePlatformInput,
} from "../../service/runtime-directory.js";
import type { ConnectorVerificationResult, LaunchDescriptor } from "../connector-types.js";
import {
  validateConnectorHostPath,
  validateConnectorStateBoundary,
  validateRepositoryFileBoundary,
} from "../connector-path-safety.js";
import { resolveConnectorStateDirectory } from "../connector-state-directory.js";
import {
  launchAgentFoldMcpWithOfficialClient,
  type AgentFoldMcpLaunchVerification,
} from "../mcp-launch-verification.js";
import { connectorConfigIdentity } from "../ownership-store.js";
import { fingerprintCodexAgentsRegion, readCodexAgentsRegion } from "./codex-agents.js";
import { discoverCodex } from "./codex-discovery.js";
import { codexMcpEntrySchema } from "./codex-launch-entry.js";
import { CodexOwnershipStore, type CodexInstallationRecord } from "./codex-ownership.js";
import {
  fingerprintCodexRegion,
  readCodexAgentFoldEntry,
  readCodexManagedRegion,
} from "./codex-toml.js";
import { resolveCodexWorktreeIdentity } from "./codex-worktree.js";

export interface VerifyCodexInput {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly processRunner: ProcessRunner;
  readonly version: string;
  readonly platform?: ServicePlatformInput;
  readonly stateDirectory?: string;
  readonly runtimeDirectory?: string;
  readonly codexHome?: string;
  readonly startDirectory?: string;
  readonly resolveDescriptor: () => Promise<LaunchDescriptor>;
  readonly launchMcp?: (
    descriptor: LaunchDescriptor,
    repositoryRoot: string,
  ) => Promise<AgentFoldMcpLaunchVerification>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export type CodexVerificationOperationResult = ConnectorVerificationResult & {
  readonly host: "codex";
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

function invalidResult(
  exitCode: 1 | 2 | 6,
  diagnostics: readonly Diagnostic[],
): CodexVerificationOperationResult {
  return {
    host: "codex",
    valid: false,
    toolsAvailable: 0,
    serviceAvailable: false,
    exitCode,
    diagnostics,
  };
}

function hasAgentFoldListing(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasAgentFoldListing);
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.name === "agentfold") return true;
  return Object.values(record).some(hasAgentFoldListing);
}

async function inspectCodexCli(input: {
  readonly executable: string;
  readonly processRunner: ProcessRunner;
  readonly repositoryRoot: string;
  readonly codexHome: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): Promise<boolean> {
  const result = await input.processRunner.run(input.executable, ["mcp", "list", "--json"], {
    cwd: input.repositoryRoot,
    environment: { ...input.environment, CODEX_HOME: input.codexHome },
  });
  if (result.exitCode !== 0) return false;
  try {
    return hasAgentFoldListing(JSON.parse(result.stdout));
  } catch {
    return false;
  }
}

function surfaceDiagnostics(
  surfaces: readonly ("cli" | "ide" | "app")[],
  cliListed: boolean | undefined,
): readonly Diagnostic[] {
  return surfaces.map((surface) => {
    if (surface === "cli") {
      return diagnostic(
        "AFCD040",
        cliListed === true ? "success" : "info",
        cliListed === true
          ? "Codex CLI lists the `agentfold` MCP server."
          : "Codex CLI configuration is valid; live CLI ingestion was not proven.",
      );
    }
    if (surface === "ide") {
      return diagnostic(
        "AFCD041",
        "info",
        "Codex IDE shares the validated configuration; restart the extension to confirm live ingestion.",
      );
    }
    return diagnostic(
      "AFCD042",
      "info",
      "Codex desktop shares the validated configuration; restart Codex to confirm live ingestion.",
    );
  });
}

export async function verifyCodexConnection(
  input: VerifyCodexInput,
): Promise<CodexVerificationOperationResult> {
  const platform = input.platform ?? nodeServicePlatformInput();
  const context = await loadCanonicalContext({
    fileSystem: input.fileSystem,
    gitRepositoryLocator: input.gitRepositoryLocator,
    ...(input.startDirectory === undefined ? {} : { startDirectory: input.startDirectory }),
  });
  if (context.status === "error") {
    return invalidResult(6, [
      diagnostic(
        "AFCD020",
        "error",
        "Codex verification requires an initialized BriefOnce repository.",
      ),
    ]);
  }
  const stateDirectory = resolveConnectorStateDirectory(platform, input.stateDirectory);
  try {
    await validateConnectorStateBoundary(input.fileSystem, context.repositoryRoot, stateDirectory);
  } catch {
    return invalidResult(1, [
      diagnostic("AFCD004", "error", "Connector state is not safely outside the repository."),
    ]);
  }
  let ownership: CodexInstallationRecord | undefined;
  try {
    ownership = await new CodexOwnershipStore(input.fileSystem, stateDirectory).read();
  } catch {
    return invalidResult(2, [
      diagnostic("AFCD021", "error", "The Codex connector ownership record is invalid."),
    ]);
  }
  if (ownership === undefined) {
    return invalidResult(1, [
      diagnostic(
        "AFCD021",
        "error",
        "Codex connector ownership is missing.",
        "Run agentfold connect codex to preview installation.",
      ),
    ]);
  }
  try {
    const worktree = await resolveCodexWorktreeIdentity({
      fileSystem: input.fileSystem,
      processRunner: input.processRunner,
      repositoryRoot: context.repositoryRoot,
      platform: platform.platform,
    });
    const workspace = ownership.workspaces.find(
      (candidate) => candidate.repositoryId === worktree.repositoryId,
    );
    if (
      workspace === undefined ||
      workspace.repositoryFamilyId !== worktree.repositoryFamilyId ||
      workspace.worktreeKind !== worktree.kind
    ) {
      return invalidResult(1, [
        diagnostic("AFCD022", "error", "This Git worktree is not recorded as connected to Codex."),
      ]);
    }
    const discovery = await discoverCodex({
      fileSystem: input.fileSystem,
      platform,
      ...(input.codexHome === undefined ? {} : { codexHome: input.codexHome }),
    });
    const configIdentity = connectorConfigIdentity(discovery.configPath, platform.platform);
    const connections = workspace.connections.filter(
      (connection) => connection.configIdentity === configIdentity,
    );
    if (connections.length === 0 || !(await input.fileSystem.exists(discovery.configPath))) {
      return invalidResult(1, [
        diagnostic("AFCD023", "error", "The recorded Codex MCP configuration is missing."),
      ]);
    }
    await validateConnectorHostPath(input.fileSystem, discovery.configPath);
    const configBytes = await input.fileSystem.readBytes(discovery.configPath);
    const region = readCodexManagedRegion(configBytes);
    const entry = readCodexAgentFoldEntry(configBytes);
    if (region === undefined || entry === undefined) {
      return invalidResult(1, [
        diagnostic("AFCD024", "error", "The BriefOnce Codex MCP region is missing."),
      ]);
    }
    codexMcpEntrySchema.parse(entry);
    const regionFingerprint = fingerprintCodexRegion(region);
    for (const connection of connections) {
      const surface = ownership.surfaces.find(
        (candidate) =>
          candidate.configIdentity === connection.configIdentity &&
          candidate.surface === connection.surface,
      );
      if (surface === undefined || surface.regionFingerprint !== regionFingerprint) {
        return invalidResult(1, [
          diagnostic(
            "AFCD025",
            "error",
            "The installed Codex MCP region differs from its ownership fingerprint.",
          ),
        ]);
      }
    }
    const descriptor = await input.resolveDescriptor();
    if (descriptor.fingerprint !== ownership.executableDescriptorFingerprint) {
      return invalidResult(1, [
        diagnostic("AFCD026", "error", "The installed BriefOnce executable descriptor is stale."),
      ]);
    }
    const agentsPath = path.join(context.repositoryRoot, "AGENTS.md");
    await validateRepositoryFileBoundary(input.fileSystem, context.repositoryRoot, agentsPath);
    if (!(await input.fileSystem.exists(agentsPath))) {
      return invalidResult(1, [
        diagnostic("AFCD027", "error", "The Codex AGENTS.md managed region is missing."),
      ]);
    }
    const agentsRegion = readCodexAgentsRegion(await input.fileSystem.readBytes(agentsPath));
    if (
      agentsRegion === undefined ||
      fingerprintCodexAgentsRegion(agentsRegion) !== workspace.agentsRegionFingerprint
    ) {
      return invalidResult(1, [
        diagnostic(
          "AFCD028",
          "error",
          "The Codex AGENTS.md region differs from its ownership fingerprint.",
        ),
      ]);
    }
    const launched = await (
      input.launchMcp ??
      ((current, root) =>
        launchAgentFoldMcpWithOfficialClient({
          descriptor: current,
          repositoryRoot: root,
          environment: input.environment ?? process.env,
          clientName: "agentfold-codex-verifier",
        }))
    )(descriptor, context.repositoryRoot);
    if (!launched.statusVerified) {
      return invalidResult(1, [
        diagnostic("AFCD029", "error", "agentfold_get_status verification failed."),
      ]);
    }
    const service = await checkAgentFoldServiceAvailability({
      fileSystem: input.fileSystem,
      clientVersion: input.version,
      ...(input.runtimeDirectory === undefined ? {} : { runtimeDirectory: input.runtimeDirectory }),
      platform,
    });
    if (!service.available) {
      return invalidResult(6, [
        diagnostic("AFCD030", "error", "Shared-service auto-start verification failed."),
      ]);
    }
    let cliListed: boolean | undefined;
    if (discovery.cliExecutable !== undefined) {
      cliListed = await inspectCodexCli({
        executable: discovery.cliExecutable,
        processRunner: input.processRunner,
        repositoryRoot: context.repositoryRoot,
        codexHome: path.dirname(discovery.configPath),
        environment: input.environment ?? process.env,
      });
      if (!cliListed) {
        return invalidResult(1, [
          diagnostic(
            "AFCD031",
            "error",
            "The available Codex CLI did not list the owned `agentfold` MCP server.",
          ),
        ]);
      }
    }
    const surfaces = [...new Set(connections.map((connection) => connection.surface))].sort();
    return {
      host: "codex",
      valid: true,
      toolsAvailable: launched.toolsAvailable,
      serviceAvailable: true,
      exitCode: 0,
      diagnostics: [
        diagnostic("AFCD032", "success", "Codex connector verification passed."),
        ...(worktree.kind === "linked"
          ? [
              diagnostic(
                "AFCD013",
                "warning",
                "This linked worktree is isolated from uncommitted changes in other worktrees.",
              ),
            ]
          : []),
        ...surfaceDiagnostics(surfaces, cliListed),
      ],
    };
  } catch {
    return invalidResult(1, [
      diagnostic(
        "AFCD033",
        "error",
        "The configured Codex MCP process could not be verified safely.",
        "Review the owned regions, restart Codex, and retry verification.",
      ),
    ]);
  }
}
