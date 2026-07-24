import path from "node:path";

import type { Diagnostic } from "../../core/diagnostics/diagnostic.js";
import type { FileSystem } from "../../core/filesystem/filesystem.js";
import type { GitRepositoryLocator } from "../../core/git/git-repository-locator.js";
import { loadCanonicalContext } from "../../core/context/load-context.js";
import type { WorkspaceMode } from "./workspace-mode.js";

export interface McpClientRoot {
  readonly uri: string;
  readonly name?: string;
}

export type McpClientRootsResult =
  | { readonly supported: true; readonly roots: readonly McpClientRoot[] }
  | { readonly supported: false };

export type WorkspaceResolutionSource = "explicit" | "roots" | "cwd";

export type WorkspaceResolutionResult =
  | {
      readonly status: "resolved";
      readonly repositoryRoot: string;
      readonly source: WorkspaceResolutionSource;
      readonly diagnostics: readonly Diagnostic[];
    }
  | { readonly status: "error"; readonly diagnostics: readonly Diagnostic[] };

export interface McpWorkspaceResolverInput {
  readonly mode: WorkspaceMode;
  readonly workspace?: string;
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly platform?: NodeJS.Platform;
}

function diagnostic(
  code: string,
  severity: Diagnostic["severity"],
  message: string,
  suggestion?: string,
): Diagnostic {
  return { code, severity, message, ...(suggestion === undefined ? {} : { suggestion }) };
}

export function decodeMcpFileRootUri(uri: string, platform: NodeJS.Platform): string {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("The MCP root URI is malformed.");
  }
  if (parsed.protocol !== "file:") throw new Error("Only file:// MCP roots are supported.");
  if (/%(?:2f|5c)/iu.test(parsed.pathname)) {
    throw new Error("Encoded path separators are not accepted in MCP roots.");
  }
  if (parsed.hostname !== "" && parsed.hostname !== "localhost") {
    throw new Error("Remote file URI hosts are not supported.");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    throw new Error("The MCP root URI contains invalid encoding.");
  }
  if (platform === "win32") {
    const withoutDriveSlash = /^\/[a-zA-Z]:\//u.test(decoded) ? decoded.slice(1) : decoded;
    return path.win32.normalize(withoutDriveSlash.replaceAll("/", "\\"));
  }
  return path.posix.normalize(decoded);
}

function pathIdentity(value: string, platform: NodeJS.Platform): string {
  const normalized = (platform === "win32" ? path.win32 : path.posix)
    .resolve(value)
    .replace(/[\\/]+$/u, "");
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

export class McpWorkspaceResolver {
  private readonly platform: NodeJS.Platform;
  private rootsProvider: (() => Promise<McpClientRootsResult>) | undefined;
  private locked: WorkspaceResolutionResult | undefined;

  constructor(private readonly input: McpWorkspaceResolverInput) {
    this.platform = input.platform ?? process.platform;
  }

  setRootsProvider(provider: () => Promise<McpClientRootsResult>): void {
    this.rootsProvider = provider;
  }

  get lockedRepositoryRoot(): string | undefined {
    return this.locked?.status === "resolved" ? this.locked.repositoryRoot : undefined;
  }

  private async validateCandidate(
    candidate: string,
    requireInitialization = true,
  ): Promise<string | undefined> {
    try {
      if ((await this.input.fileSystem.entryType(candidate)) !== "directory") return undefined;
      const realCandidate = await this.input.fileSystem.realPath(candidate);
      const located = await this.input.gitRepositoryLocator.findRoot(realCandidate);
      if (located === undefined) return undefined;
      const repositoryRoot = await this.input.fileSystem.realPath(located);
      if (!requireInitialization) return repositoryRoot;
      const context = await loadCanonicalContext({
        fileSystem: this.input.fileSystem,
        gitRepositoryLocator: this.input.gitRepositoryLocator,
        startDirectory: repositoryRoot,
      });
      return context.status === "success" ? repositoryRoot : undefined;
    } catch {
      return undefined;
    }
  }

  private async resolveRoots(): Promise<WorkspaceResolutionResult> {
    if (this.rootsProvider === undefined) {
      return {
        status: "error",
        diagnostics: [
          diagnostic(
            "AFMCP016",
            "error",
            "The MCP client does not expose workspace roots.",
            "Use --workspace, use --workspace-mode auto from an initialized repository, or enable roots in the host.",
          ),
        ],
      };
    }
    let rootResult: McpClientRootsResult;
    try {
      rootResult = await this.rootsProvider();
    } catch {
      rootResult = { supported: false };
    }
    if (!rootResult.supported) {
      return {
        status: "error",
        diagnostics: [
          diagnostic(
            "AFMCP016",
            "error",
            "The MCP client does not support workspace roots.",
            "Enable roots in the host or use --workspace-mode auto from an initialized repository.",
          ),
        ],
      };
    }
    const repositories = new Map<string, string>();
    let invalidRoot = false;
    for (const root of rootResult.roots) {
      try {
        const candidate = decodeMcpFileRootUri(root.uri, this.platform);
        const repository = await this.validateCandidate(candidate);
        if (repository === undefined) {
          invalidRoot = true;
          continue;
        }
        repositories.set(pathIdentity(repository, this.platform), repository);
      } catch {
        invalidRoot = true;
      }
    }
    if (repositories.size === 1) {
      return {
        status: "resolved",
        repositoryRoot: [...repositories.values()][0]!,
        source: "roots",
        diagnostics: [
          diagnostic(
            "AFMCP017",
            "success",
            "The BriefOnce workspace was resolved through MCP roots.",
          ),
          ...(invalidRoot
            ? [
                diagnostic(
                  "AFMCP016",
                  "warning",
                  "One or more unsupported or uninitialized MCP roots were ignored.",
                ),
              ]
            : []),
        ],
      };
    }
    if (repositories.size > 1) {
      return {
        status: "error",
        diagnostics: [
          diagnostic(
            "AFMCP019",
            "error",
            "Several initialized BriefOnce repositories were exposed through MCP roots.",
            "Open one repository in this MCP process or pass an explicit --workspace.",
          ),
        ],
      };
    }
    return {
      status: "error",
      diagnostics: [
        diagnostic(
          "AFMCP020",
          "error",
          "No initialized BriefOnce repository could be resolved from MCP roots.",
          "Open an initialized repository or pass --workspace.",
        ),
      ],
    };
  }

  private async resolveCwd(): Promise<WorkspaceResolutionResult> {
    let cwd: string;
    try {
      cwd = this.input.fileSystem.currentWorkingDirectory();
    } catch {
      return {
        status: "error",
        diagnostics: [diagnostic("AFMCP020", "error", "The MCP working directory is unavailable.")],
      };
    }
    const repositoryRoot = await this.validateCandidate(cwd, this.input.mode !== "fixed");
    if (repositoryRoot === undefined) {
      return {
        status: "error",
        diagnostics: [
          diagnostic(
            "AFMCP020",
            "error",
            "The MCP working directory is not an initialized BriefOnce repository.",
            "Open an initialized repository or pass --workspace.",
          ),
        ],
      };
    }
    return {
      status: "resolved",
      repositoryRoot,
      source: "cwd",
      diagnostics: [
        diagnostic(
          "AFMCP018",
          "success",
          "The BriefOnce workspace was resolved through the MCP working directory.",
        ),
      ],
    };
  }

  async resolve(): Promise<WorkspaceResolutionResult> {
    if (this.locked !== undefined) return this.locked;
    let result: WorkspaceResolutionResult;
    if (this.input.workspace !== undefined) {
      const cwd = this.input.fileSystem.currentWorkingDirectory();
      const platformPath = this.platform === "win32" ? path.win32 : path.posix;
      const repositoryRoot = await this.validateCandidate(
        platformPath.resolve(cwd, this.input.workspace),
        false,
      );
      result =
        repositoryRoot === undefined
          ? {
              status: "error",
              diagnostics: [
                diagnostic(
                  "AFMCP020",
                  "error",
                  "The explicit MCP workspace is not an initialized BriefOnce repository.",
                  "Pass a directory inside an initialized BriefOnce Git repository.",
                ),
              ],
            }
          : {
              status: "resolved",
              repositoryRoot,
              source: "explicit",
              diagnostics: [],
            };
    } else if (this.input.mode === "roots") {
      result = await this.resolveRoots();
    } else if (this.input.mode === "auto") {
      const roots = await this.resolveRoots();
      result =
        roots.status === "resolved" || roots.diagnostics.some((item) => item.code === "AFMCP019")
          ? roots
          : await this.resolveCwd();
    } else {
      result = await this.resolveCwd();
    }
    if (result.status === "resolved") this.locked = result;
    return result;
  }

  async inspectRootsAfterLock(): Promise<Diagnostic | undefined> {
    if (this.locked?.status !== "resolved" || this.rootsProvider === undefined) return undefined;
    const roots = await this.resolveRoots();
    if (
      roots.status === "resolved" &&
      pathIdentity(roots.repositoryRoot, this.platform) ===
        pathIdentity(this.locked.repositoryRoot, this.platform)
    ) {
      return undefined;
    }
    return diagnostic(
      "AFMCP021",
      "warning",
      "MCP roots changed after BriefOnce locked this process to a repository.",
      "Restart the MCP process to select a different repository.",
    );
  }
}
