import { Option, type Command } from "commander";

import type { Diagnostic } from "../../core/diagnostics/diagnostic.js";
import { formatDiagnostic } from "../../core/diagnostics/format-diagnostic.js";
import type { FileSystem } from "../../core/filesystem/filesystem.js";
import type { GitRepositoryLocator } from "../../core/git/git-repository-locator.js";
import {
  commitProjectStorageMigration,
  prepareProjectStorageMigration,
  ProjectStorageMigrationConflictError,
  ProjectStorageMigrationRollbackError,
  type ProjectStorageMigrationPlan,
} from "../../core/migration/migrate-project-storage.js";
import { productBrand } from "../../product-brand.js";
import { CliCommandError } from "../command-error.js";
import type { CliOutput } from "../output/cli-output.js";
import { writeLine } from "../output/cli-output.js";

export interface MigrateDependencies {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
}

interface MigrateCommandOptions {
  readonly dryRun?: boolean;
  readonly yes?: boolean;
}

function writePlan(output: CliOutput, plan: ProjectStorageMigrationPlan): void {
  writeLine(output, `${productBrand.productName} project storage migration`);
  writeLine(output);
  for (const diagnostic of plan.diagnostics) {
    writeLine(output, formatDiagnostic(diagnostic, { color: output.useColor }));
  }
  if (plan.status === "ready") {
    writeLine(output);
    writeLine(output, "Planned changes");
    writeLine(output, "  - Rename .agentfold to .briefonce");
    writeLine(output, "  - Normalize legacy paths in .briefonce/manifest.json");
    writeLine(output, "  - Preserve all canonical context, task state, and checkpoint history");
  }
}

export function registerMigrateCommand(
  program: Command,
  dependencies: MigrateDependencies,
  output: CliOutput,
): void {
  program
    .command("migrate")
    .description("Safely migrate legacy .agentfold project storage to .briefonce")
    .addOption(new Option("--dry-run", "preview migration without writing").conflicts("yes"))
    .addOption(new Option("--yes", "migrate non-interactively").conflicts("dryRun"))
    .action(async (options: MigrateCommandOptions) => {
      const plan = await prepareProjectStorageMigration(dependencies);
      writePlan(output, plan);
      if (plan.exitCode !== 0) {
        throw new CliCommandError(plan.exitCode, "BriefOnce storage migration could not proceed");
      }
      if (plan.status !== "ready") return;
      if (options.yes !== true) {
        writeLine(output);
        writeLine(
          output,
          options.dryRun === true
            ? "Dry run complete. No files were changed."
            : "Preview complete. Re-run with --yes to migrate.",
        );
        return;
      }

      let diagnostics: readonly Diagnostic[];
      try {
        diagnostics = await commitProjectStorageMigration(plan, dependencies.fileSystem);
      } catch (error: unknown) {
        const rollbackFailure = error instanceof ProjectStorageMigrationRollbackError;
        const conflict = error instanceof ProjectStorageMigrationConflictError;
        writeLine(output);
        writeLine(
          output,
          formatDiagnostic(
            {
              code: rollbackFailure ? "AFMG010" : conflict ? "AFMG009" : "AFMG011",
              severity: "error",
              message: error instanceof Error ? error.message : "Project storage migration failed.",
              suggestion: rollbackFailure
                ? "Inspect both project directories manually before retrying."
                : "No existing project directory was overwritten.",
            },
            { color: output.useColor },
          ),
        );
        throw new CliCommandError(conflict ? 5 : 1, "BriefOnce storage migration failed");
      }
      const completion = diagnostics.at(-1);
      if (completion !== undefined) {
        writeLine(output);
        writeLine(output, formatDiagnostic(completion, { color: output.useColor }));
      }
    });
}
