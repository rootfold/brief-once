import path from "node:path";

import type { FileSystem } from "../../core/filesystem/filesystem.js";
import type { GitRepositoryLocator } from "../../core/git/git-repository-locator.js";
import { canonicalRepositoryId } from "../../core/reliability/repository-identity.js";

export interface RegisteredRepository {
  readonly repositoryId: string;
  readonly absoluteRoot: string;
  readonly registeredAt: string;
  readonly lastActivityAt: string;
  readonly activeSessionIds: readonly string[];
}

export interface RepositoryRegistryOptions {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly now?: () => Date;
  readonly platform?: NodeJS.Platform;
}

export class RepositoryRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryRegistrationError";
  }
}

export class RepositoryRegistry {
  private readonly repositories = new Map<string, RegisteredRepository>();
  private readonly now: () => Date;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: RepositoryRegistryOptions) {
    this.now = options.now ?? (() => new Date());
    this.platform = options.platform ?? process.platform;
  }

  async register(workspace: string): Promise<RegisteredRepository> {
    const requested = path.resolve(this.options.fileSystem.currentWorkingDirectory(), workspace);
    if ((await this.options.fileSystem.entryType(requested)) !== "directory") {
      throw new RepositoryRegistrationError("The requested workspace is not a directory.");
    }
    const realWorkspace = await this.options.fileSystem.realPath(requested);
    const locatedRoot = await this.options.gitRepositoryLocator.findRoot(realWorkspace);
    if (locatedRoot === undefined) {
      throw new RepositoryRegistrationError(
        "The requested workspace is not inside a Git repository.",
      );
    }
    const absoluteRoot = await this.options.fileSystem.realPath(path.resolve(locatedRoot));
    const repositoryId = canonicalRepositoryId(absoluteRoot, this.platform);
    const existing = this.repositories.get(repositoryId);
    if (existing !== undefined) return this.touch(repositoryId) ?? existing;
    const timestamp = this.now().toISOString();
    const repository = {
      repositoryId,
      absoluteRoot,
      registeredAt: timestamp,
      lastActivityAt: timestamp,
      activeSessionIds: [],
    };
    this.repositories.set(repositoryId, repository);
    return repository;
  }

  async restore(
    canonicalRoot: string,
    expectedRepositoryId: string,
  ): Promise<RegisteredRepository | undefined> {
    try {
      if ((await this.options.fileSystem.entryType(canonicalRoot)) !== "directory")
        return undefined;
      const realRoot = await this.options.fileSystem.realPath(path.resolve(canonicalRoot));
      const locatedRoot = await this.options.gitRepositoryLocator.findRoot(realRoot);
      if (locatedRoot === undefined) return undefined;
      const canonicalLocatedRoot = await this.options.fileSystem.realPath(
        path.resolve(locatedRoot),
      );
      if (canonicalRepositoryId(canonicalLocatedRoot, this.platform) !== expectedRepositoryId) {
        return undefined;
      }
      return this.register(canonicalLocatedRoot);
    } catch {
      return undefined;
    }
  }

  get(repositoryId: string): RegisteredRepository | undefined {
    return this.repositories.get(repositoryId);
  }

  touch(repositoryId: string): RegisteredRepository | undefined {
    const existing = this.repositories.get(repositoryId);
    if (existing === undefined) return undefined;
    const updated = { ...existing, lastActivityAt: this.now().toISOString() };
    this.repositories.set(repositoryId, updated);
    return updated;
  }

  attachSession(repositoryId: string, sessionId: string): void {
    const existing = this.repositories.get(repositoryId);
    if (existing === undefined) return;
    this.repositories.set(repositoryId, {
      ...existing,
      lastActivityAt: this.now().toISOString(),
      activeSessionIds: [...new Set([...existing.activeSessionIds, sessionId])],
    });
  }

  detachSession(repositoryId: string, sessionId: string): void {
    const existing = this.repositories.get(repositoryId);
    if (existing === undefined) return;
    this.repositories.set(repositoryId, {
      ...existing,
      lastActivityAt: this.now().toISOString(),
      activeSessionIds: existing.activeSessionIds.filter((candidate) => candidate !== sessionId),
    });
  }

  count(): number {
    return this.repositories.size;
  }

  all(): readonly RegisteredRepository[] {
    return [...this.repositories.values()];
  }
}
