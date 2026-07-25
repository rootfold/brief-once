import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AtomicFileConflictError,
  AtomicTextFileWriter,
} from "../../src/core/filesystem/atomic-text-file-writer.js";
import { NodeFileSystem } from "../../src/core/filesystem/node-filesystem.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ readonly root: string; readonly fileSystem: NodeFileSystem }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentfold-atomic-state-"));
  temporaryDirectories.push(root);
  return { root, fileSystem: new NodeFileSystem(() => root) };
}

describe("AtomicTextFileWriter", () => {
  it("atomically creates a flushed state file and refuses replacement in create mode", async () => {
    const testFixture = await fixture();
    const destination = path.join(testFixture.root, ".briefonce", "state", "current.md");
    const writer = new AtomicTextFileWriter(testFixture.fileSystem, () => ".current.tmp");

    await writer.write(destination, "first\n", "create");
    await expect(testFixture.fileSystem.readText(destination)).resolves.toBe("first\n");
    await expect(writer.write(destination, "second\n", "create")).rejects.toBeInstanceOf(
      AtomicFileConflictError,
    );
    await expect(testFixture.fileSystem.readText(destination)).resolves.toBe("first\n");
  });

  it("cleans a temporary file after a flushed-write failure", async () => {
    const testFixture = await fixture();
    class FailingFileSystem extends NodeFileSystem {
      override writeTextAndFlush(): Promise<void> {
        return Promise.reject(new Error("Simulated flushed-write failure"));
      }
    }
    const fileSystem = new FailingFileSystem(() => testFixture.root);
    const destination = path.join(testFixture.root, ".briefonce", "state", "current.md");
    const temporary = path.join(path.dirname(destination), ".current.tmp");

    await expect(
      new AtomicTextFileWriter(fileSystem, () => ".current.tmp").write(
        destination,
        "content\n",
        "create",
      ),
    ).rejects.toThrow("Simulated flushed-write failure");
    await expect(testFixture.fileSystem.exists(destination)).resolves.toBe(false);
    await expect(testFixture.fileSystem.exists(temporary)).resolves.toBe(false);
  });

  it("preserves the previous state when atomic replacement fails", async () => {
    const testFixture = await fixture();
    class FailingRenameFileSystem extends NodeFileSystem {
      override rename(): Promise<void> {
        return Promise.reject(new Error("Simulated rename failure"));
      }
    }
    const destination = path.join(testFixture.root, "current.md");
    await testFixture.fileSystem.writeText(destination, "previous\n");
    const fileSystem = new FailingRenameFileSystem(() => testFixture.root);

    await expect(
      new AtomicTextFileWriter(fileSystem, () => ".current.tmp").write(
        destination,
        "replacement\n",
        "replace",
      ),
    ).rejects.toThrow("Simulated rename failure");
    await expect(testFixture.fileSystem.readText(destination)).resolves.toBe("previous\n");
    await expect(
      testFixture.fileSystem.exists(path.join(testFixture.root, ".current.tmp")),
    ).resolves.toBe(false);
  });
});
