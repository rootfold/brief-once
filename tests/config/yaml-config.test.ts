import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigSyntaxError, loadConfig } from "../../src/core/config/load-config.js";
import { ConfigValidationError, parseConfig } from "../../src/core/config/parse-config.js";
import { serializeConfig } from "../../src/core/config/serialize-config.js";
import { NodeFileSystem } from "../../src/core/filesystem/node-filesystem.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function minimalConfig(): ReturnType<typeof parseConfig> {
  return parseConfig({
    version: 1,
    project: { name: "Example", summary: "" },
    runtime: { node: ">=20" },
    commands: {},
    state: { visibility: "local" },
    safety: { respect_gitignore: true, excluded_paths: [] },
    adapters: {},
  });
}

async function configFixture(content: string): Promise<{
  readonly fileSystem: NodeFileSystem;
  readonly configPath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentfold-yaml-"));
  temporaryDirectories.push(root);
  const directory = path.join(root, ".briefonce");
  const configPath = path.join(directory, "config.yaml");
  await mkdir(directory);
  await writeFile(configPath, content, "utf8");
  return { fileSystem: new NodeFileSystem(() => root), configPath };
}

describe("AgentFold YAML configuration", () => {
  it("serializes deterministically and loads through the Zod boundary", async () => {
    const serialized = serializeConfig(minimalConfig());
    const fixture = await configFixture(serialized);

    expect(serialized).toContain("version: 1");
    expect(serialized).toContain('summary: ""');
    await expect(loadConfig(fixture.fileSystem, fixture.configPath)).resolves.toEqual(
      minimalConfig(),
    );
  });

  it("reports YAML syntax errors", async () => {
    const fixture = await configFixture("version: [\n");

    await expect(loadConfig(fixture.fileSystem, fixture.configPath)).rejects.toBeInstanceOf(
      ConfigSyntaxError,
    );
  });

  it("reports schema validation paths after YAML loading", async () => {
    const fixture = await configFixture(
      serializeConfig({ ...minimalConfig(), state: { visibility: "local" } }).replace(
        "visibility: local",
        "visibility: shared",
      ),
    );

    await expect(loadConfig(fixture.fileSystem, fixture.configPath)).rejects.toMatchObject({
      name: ConfigValidationError.name,
      issues: expect.arrayContaining([expect.objectContaining({ path: "state.visibility" })]),
    });
  });

  it("normalizes, sorts, deduplicates, and portably serializes repository paths", () => {
    const config = parseConfig({
      ...minimalConfig(),
      paths: {
        source: ["src\\features", "src/features", " ./lib/ "],
        tests: [],
        documentation: ["docs\\reference"],
      },
    });

    expect(config.paths).toEqual({
      source: ["lib", "src/features"],
      tests: [],
      documentation: ["docs/reference"],
    });
    const serialized = serializeConfig(config);
    expect(serialized).toContain("- src/features");
    expect(serialized).toContain("- docs/reference");
    expect(serialized).not.toContain("\\");
  });

  it.each(["C:\\secrets", "C:/secrets", "/etc/secrets", "\\\\server\\share"])(
    "rejects absolute repository path %s",
    (configuredPath) => {
      expect(() =>
        parseConfig({
          ...minimalConfig(),
          paths: { source: [configuredPath] },
        }),
      ).toThrow(ConfigValidationError);
    },
  );

  it.each(["../secrets", "src/../secrets", "src\\..\\secrets"])(
    "rejects parent traversal %s",
    (configuredPath) => {
      expect(() =>
        parseConfig({
          ...minimalConfig(),
          paths: { source: [configuredPath] },
        }),
      ).toThrow(ConfigValidationError);
    },
  );

  it("loads a UTF-8 BOM configuration", async () => {
    const fixture = await configFixture(`\uFEFF${serializeConfig(minimalConfig())}`);

    await expect(loadConfig(fixture.fileSystem, fixture.configPath)).resolves.toEqual(
      minimalConfig(),
    );
  });
});
