import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { parseConfig } from "../../src/core/config/parse-config.js";
import { serializeConfig } from "../../src/core/config/serialize-config.js";
import type { AgentFoldConfig } from "../../src/core/config/types.js";
import { loadCanonicalContext } from "../../src/core/context/load-context.js";
import type {
  CanonicalContextLoadResult,
  CanonicalContextSuccess,
} from "../../src/core/context/types.js";
import { NodeFileSystem } from "../../src/core/filesystem/node-filesystem.js";
import { FilesystemGitRepositoryLocator } from "../../src/core/git/filesystem-git-repository-locator.js";

const temporaryDirectories: string[] = [];

const contextDocuments = {
  "project.md": "\uFEFF# Project\r\n\r\nProject context.\r\n",
  "architecture.md": "# Architecture\n\nArchitecture context.\n",
  "commands.md": "# Commands\r\n\r\nCommands context.\r\n",
  "conventions.md": "# Conventions\n\nConventions context.\n",
  "safety.md": "# Safety\r\n\r\nSafety context.\r\n",
} as const;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function baseConfig(): AgentFoldConfig {
  return parseConfig({
    version: 1,
    project: { name: "Context Fixture", summary: "A fixture project." },
    runtime: { node: ">=20" },
    package_manager: "pnpm",
    commands: { test: "pnpm test" },
    paths: {
      source: ["src\\features", "src/features"],
      tests: ["tests"],
      documentation: ["docs"],
      generated: ["dist"],
    },
    state: { visibility: "local" },
    safety: { respect_gitignore: true, excluded_paths: [".env"] },
    adapters: {
      codex: { enabled: true, output: "AGENTS.md" },
      claude: { enabled: false, output: "CLAUDE.md" },
    },
  });
}

async function repositoryFixture(
  name = "agentfold context spaces ",
): Promise<{ readonly root: string; readonly fileSystem: NodeFileSystem }> {
  const root = await mkdtemp(path.join(os.tmpdir(), name));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, ".briefonce", "context"), { recursive: true });
  await Promise.all(
    ["src/features", "tests", "docs", "dist"].map((directory) =>
      mkdir(path.join(root, ...directory.split("/")), { recursive: true }),
    ),
  );
  await writeFile(
    path.join(root, ".briefonce", "config.yaml"),
    serializeConfig(baseConfig()),
    "utf8",
  );
  await Promise.all(
    Object.entries(contextDocuments).map(([file, content]) =>
      writeFile(path.join(root, ".briefonce", "context", file), content, "utf8"),
    ),
  );

  return { root, fileSystem: new NodeFileSystem(() => root) };
}

function success(result: CanonicalContextLoadResult): CanonicalContextSuccess {
  expect(result.status).toBe("success");
  if (result.status !== "success") {
    throw new Error("Expected canonical context resolution to succeed");
  }
  return result;
}

async function load(
  root: string,
  fileSystem: NodeFileSystem = new NodeFileSystem(() => root),
  startDirectory = root,
): Promise<CanonicalContextLoadResult> {
  return loadCanonicalContext({
    fileSystem,
    gitRepositoryLocator: new FilesystemGitRepositoryLocator(fileSystem),
    startDirectory,
  });
}

describe("loadCanonicalContext", () => {
  it("resolves one normalized model with all five context files from a nested path", async () => {
    const fixture = await repositoryFixture();
    const nested = path.join(fixture.root, "packages", "example app");
    await mkdir(nested, { recursive: true });

    const result = success(await load(fixture.root, fixture.fileSystem, nested));

    expect(result.repositoryRoot).toBe(fixture.root);
    expect(result.context).toMatchObject({
      schemaVersion: 1,
      repositoryRoot: fixture.root,
      project: { name: "Context Fixture", summary: "A fixture project." },
      runtime: { node: ">=20" },
      packageManager: "pnpm",
      commands: { test: "pnpm test" },
      paths: {
        source: ["src/features"],
        tests: ["tests"],
        documentation: ["docs"],
        generated: ["dist"],
      },
      safety: { respectGitignore: true, excludedPaths: [".env"] },
      state: { visibility: "local" },
      enabledAdapters: { codex: { enabled: true, output: "AGENTS.md" } },
    });
    expect(result.context.context).toEqual({
      project: "# Project\n\nProject context.\n",
      architecture: "# Architecture\n\nArchitecture context.\n",
      commands: "# Commands\n\nCommands context.\n",
      conventions: "# Conventions\n\nConventions context.\n",
      safety: "# Safety\n\nSafety context.\n",
    });
    expect(result.diagnostics).toEqual([]);
  });

  it("reports a missing configuration without reading context", async () => {
    const fixture = await repositoryFixture();
    await rm(path.join(fixture.root, ".briefonce", "config.yaml"));

    const result = await load(fixture.root, fixture.fileSystem);

    expect(result).toMatchObject({ status: "error" });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "AFC002", severity: "error" }),
    );
  });

  it("applies empty path groups when an older valid configuration omits paths", async () => {
    const fixture = await repositoryFixture();
    const config = parseConfig({
      version: 1,
      project: { name: "Legacy Fixture", summary: "" },
      runtime: { node: ">=20" },
      commands: {},
      state: { visibility: "local" },
      safety: { respect_gitignore: true, excluded_paths: [] },
      adapters: {},
    });
    await writeFile(
      path.join(fixture.root, ".briefonce", "config.yaml"),
      serializeConfig(config),
      "utf8",
    );

    const result = success(await load(fixture.root, fixture.fileSystem));

    expect(result.context.paths).toEqual({
      source: [],
      tests: [],
      documentation: [],
      generated: [],
    });
  });

  it("distinguishes invalid YAML from schema-invalid configuration", async () => {
    const invalidYaml = await repositoryFixture("agentfold-invalid-yaml-");
    await writeFile(
      path.join(invalidYaml.root, ".briefonce", "config.yaml"),
      "version: [\n",
      "utf8",
    );
    const yamlResult = await load(invalidYaml.root, invalidYaml.fileSystem);
    expect(yamlResult.diagnostics).toContainEqual(
      expect.objectContaining({ code: "AFC003", severity: "error" }),
    );

    const invalidSchema = await repositoryFixture("agentfold-invalid-schema-");
    await writeFile(
      path.join(invalidSchema.root, ".briefonce", "config.yaml"),
      serializeConfig(baseConfig()).replace("visibility: local", "visibility: shared"),
      "utf8",
    );
    const schemaResult = await load(invalidSchema.root, invalidSchema.fileSystem);
    expect(schemaResult.diagnostics).toContainEqual(
      expect.objectContaining({ code: "AFC004", severity: "error" }),
    );
  });

  it("reports every missing canonical context file as an error", async () => {
    const fixture = await repositoryFixture();
    await rm(path.join(fixture.root, ".briefonce", "context", "architecture.md"));
    await rm(path.join(fixture.root, ".briefonce", "context", "safety.md"));

    const result = await load(fixture.root, fixture.fileSystem);

    expect(result.status).toBe("error");
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "AFC005")).toHaveLength(2);
  });

  it("warns for whitespace-only context and ignores unknown context files", async () => {
    const fixture = await repositoryFixture();
    await writeFile(
      path.join(fixture.root, ".briefonce", "context", "commands.md"),
      " \r\n\t",
      "utf8",
    );
    await writeFile(
      path.join(fixture.root, ".briefonce", "context", "notes.md"),
      "# Extra\n",
      "utf8",
    );

    const result = success(await load(fixture.root, fixture.fileSystem));

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "AFC006",
        severity: "warning",
        message: expect.stringContaining("commands.md"),
      }),
    );
    expect(result.context.context.commands).toBe(" \n\t");
  });

  it("warns for a missing configured path and accepts an existing path containing spaces", async () => {
    const fixture = await repositoryFixture();
    await mkdir(path.join(fixture.root, "source files"));
    const config = parseConfig({
      ...baseConfig(),
      paths: { source: ["source files", "missing folder"] },
    });
    await writeFile(
      path.join(fixture.root, ".briefonce", "config.yaml"),
      serializeConfig(config),
      "utf8",
    );

    const result = success(await load(fixture.root, fixture.fileSystem));

    expect(result.context.paths.source).toEqual(["missing folder", "source files"]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "AFC008",
        severity: "warning",
        message: expect.stringContaining("missing folder"),
      }),
    );
    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "AFC008", message: expect.stringContaining("source files") }),
    );
  });

  it("rejects a configured directory that resolves through a symlink outside the repository", async () => {
    const fixture = await repositoryFixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "agentfold-outside-source-"));
    temporaryDirectories.push(outside);
    await mkdir(path.join(outside, "features"));
    await rm(path.join(fixture.root, "src"), { recursive: true });
    await symlink(
      outside,
      path.join(fixture.root, "src"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const result = await load(fixture.root, fixture.fileSystem);

    expect(result.status).toBe("error");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "AFC007", severity: "error" }),
    );
  });

  it("refuses to read canonical context through an escaping directory symlink", async () => {
    const fixture = await repositoryFixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "agentfold-outside-context-"));
    temporaryDirectories.push(outside);
    await Promise.all(
      Object.entries(contextDocuments).map(([file, content]) =>
        writeFile(path.join(outside, file), content, "utf8"),
      ),
    );
    const contextDirectory = path.join(fixture.root, ".briefonce", "context");
    await rm(contextDirectory, { recursive: true });
    await symlink(outside, contextDirectory, process.platform === "win32" ? "junction" : "dir");

    const result = await load(fixture.root, fixture.fileSystem);

    expect(result.status).toBe("error");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "AFC010", severity: "error" }),
    );
  });

  it("returns a structured diagnostic for filesystem read failures", async () => {
    const fixture = await repositoryFixture();
    class FailingReadFileSystem extends NodeFileSystem {
      override readText(filePath: string): Promise<string> {
        if (filePath.endsWith(path.join("context", "commands.md"))) {
          return Promise.reject(new Error("Simulated context read failure"));
        }
        return super.readText(filePath);
      }
    }
    const fileSystem = new FailingReadFileSystem(() => fixture.root);

    const result = await load(fixture.root, fileSystem);

    expect(result.status).toBe("error");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "AFC009",
        severity: "error",
        message: expect.stringContaining("Simulated context read failure"),
      }),
    );
  });
});
