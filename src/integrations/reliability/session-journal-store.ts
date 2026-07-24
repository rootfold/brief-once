import path from "node:path";

import { z } from "zod";

import { AtomicTextFileWriter } from "../../core/filesystem/atomic-text-file-writer.js";
import type { FileSystem } from "../../core/filesystem/filesystem.js";
import {
  persistentSessionJournalSchema,
  type PersistentSessionJournal,
} from "./session-journal-schema.js";

export class SessionJournalError extends Error {
  constructor(
    readonly code: "corrupt" | "unsafe" | "write_failed",
    message: string,
  ) {
    super(message);
    this.name = "SessionJournalError";
  }
}

export interface PersistentSessionJournalStoreOptions {
  readonly fileSystem: FileSystem;
  readonly stateDirectory: string;
  readonly restrictFile?: (filePath: string) => Promise<void>;
}

async function defaultRestrictFile(filePath: string): Promise<void> {
  if (process.platform !== "win32") {
    const { chmod } = await import("node:fs/promises");
    await chmod(filePath, 0o600);
  }
}

export class PersistentSessionJournalStore {
  readonly filePath: string;

  constructor(private readonly options: PersistentSessionJournalStoreOptions) {
    this.filePath = path.join(options.stateDirectory, "session-journal.json");
  }

  private async rejectUnsafeFile(): Promise<void> {
    if (
      this.options.fileSystem.isSymbolicLink !== undefined &&
      (await this.options.fileSystem.isSymbolicLink(this.filePath))
    ) {
      throw new SessionJournalError("unsafe", "The persistent session journal is a symbolic link.");
    }
  }

  async read(): Promise<PersistentSessionJournal | undefined> {
    await this.rejectUnsafeFile();
    if (!(await this.options.fileSystem.exists(this.filePath))) return undefined;
    try {
      const source = (await this.options.fileSystem.readText(this.filePath))
        .replace(/^\uFEFF/u, "")
        .replace(/\r\n?/gu, "\n");
      return persistentSessionJournalSchema.parse(JSON.parse(source));
    } catch (error: unknown) {
      if (error instanceof SessionJournalError) throw error;
      throw new SessionJournalError(
        "corrupt",
        error instanceof z.ZodError
          ? "The persistent session journal schema is invalid."
          : "The persistent session journal is not valid JSON.",
      );
    }
  }

  async write(journal: PersistentSessionJournal): Promise<void> {
    const parsed = persistentSessionJournalSchema.parse(journal);
    await this.rejectUnsafeFile();
    try {
      await new AtomicTextFileWriter(this.options.fileSystem).write(
        this.filePath,
        `${JSON.stringify(parsed, undefined, 2)}\n`,
        (await this.options.fileSystem.exists(this.filePath)) ? "replace" : "create",
      );
      await (this.options.restrictFile ?? defaultRestrictFile)(this.filePath);
    } catch (error: unknown) {
      if (error instanceof SessionJournalError) throw error;
      throw new SessionJournalError(
        "write_failed",
        "The persistent session journal could not be written atomically.",
      );
    }
  }
}
