import { defaultReliabilityPolicy } from "../../core/config/reliability-policy.js";
import { loadCanonicalContext } from "../../core/context/load-context.js";
import type { FileSystem } from "../../core/filesystem/filesystem.js";
import type { GitRepositoryLocator } from "../../core/git/git-repository-locator.js";
import { canonicalRepositoryId } from "../../core/reliability/repository-identity.js";
import type { ServicePlatformInput } from "../service/runtime-directory.js";
import { createReliabilityRecorder, type ReliabilityRecorder } from "./recorder.js";
import {
  prepareReliabilityStateDirectory,
  resolveReliabilityStateDirectory,
} from "./state-directory.js";

export interface PrepareRepositoryReliabilityInput {
  readonly repositoryRoot: string;
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly stateDirectory?: string;
  readonly platform?: ServicePlatformInput;
  readonly now?: () => Date;
  readonly generateEventId?: () => string;
}

export interface PreparedRepositoryReliability {
  readonly stateDirectory: string;
  readonly repositoryId: string;
  readonly recorder: ReliabilityRecorder;
}

export async function prepareRepositoryReliability(
  input: PrepareRepositoryReliabilityInput,
): Promise<PreparedRepositoryReliability> {
  const canonicalRoot = await input.fileSystem.realPath(input.repositoryRoot);
  const repositoryId = canonicalRepositoryId(
    canonicalRoot,
    input.platform?.platform ?? process.platform,
  );
  const canonical = await loadCanonicalContext({
    fileSystem: input.fileSystem,
    gitRepositoryLocator: input.gitRepositoryLocator,
    startDirectory: canonicalRoot,
  });
  const policy =
    canonical.status === "success" ? canonical.context.reliability : defaultReliabilityPolicy;
  if (!policy.enabled) {
    const stateDirectory = resolveReliabilityStateDirectory(input.platform, input.stateDirectory);
    return {
      stateDirectory,
      repositoryId,
      recorder: createReliabilityRecorder({
        repositoryId,
        stateDirectory,
        policy,
        fileSystem: input.fileSystem,
      }),
    };
  }
  const stateDirectory = await prepareReliabilityStateDirectory({
    fileSystem: input.fileSystem,
    gitRepositoryLocator: input.gitRepositoryLocator,
    ...(input.stateDirectory === undefined ? {} : { stateDirectory: input.stateDirectory }),
    ...(input.platform === undefined ? {} : { platform: input.platform }),
  });
  return {
    stateDirectory,
    repositoryId,
    recorder: createReliabilityRecorder({
      repositoryId,
      stateDirectory,
      policy,
      fileSystem: input.fileSystem,
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.generateEventId === undefined ? {} : { generateEventId: input.generateEventId }),
    }),
  };
}
