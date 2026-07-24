import type { Diagnostic } from "../../core/diagnostics/diagnostic.js";
import type { FileSystem } from "../../core/filesystem/filesystem.js";
import type { GitRepositoryLocator } from "../../core/git/git-repository-locator.js";
import type { ReliabilityEventInput } from "../../core/reliability/event-schema.js";
import type { ServicePlatformInput } from "../service/runtime-directory.js";
import { prepareRepositoryReliability } from "./create-recorder.js";

export interface RecordCliReliabilityInput {
  readonly repositoryRoot: string;
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly event: Omit<ReliabilityEventInput, "host">;
  readonly stateDirectory?: string;
  readonly platform?: ServicePlatformInput;
  readonly now?: () => Date;
  readonly generateEventId?: () => string;
  readonly enabled: boolean | undefined;
}

export async function recordCliReliability(
  input: RecordCliReliabilityInput,
): Promise<readonly Diagnostic[]> {
  if (input.enabled !== true) return [];
  try {
    const prepared = await prepareRepositoryReliability({
      repositoryRoot: input.repositoryRoot,
      fileSystem: input.fileSystem,
      gitRepositoryLocator: input.gitRepositoryLocator,
      ...(input.stateDirectory === undefined ? {} : { stateDirectory: input.stateDirectory }),
      ...(input.platform === undefined ? {} : { platform: input.platform }),
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.generateEventId === undefined ? {} : { generateEventId: input.generateEventId }),
    });
    return prepared.recorder.record({ host: "cli", ...input.event });
  } catch {
    return [
      {
        code: "AFREL003",
        severity: "warning",
        message:
          "Reliability metadata could not be persisted; the CLI lifecycle operation still succeeded.",
        suggestion: "Review the private AgentFold user-state directory.",
      },
    ];
  }
}
