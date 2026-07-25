import { Option, type Command } from "commander";

import type { Diagnostic } from "../../core/diagnostics/diagnostic.js";
import { formatDiagnostic } from "../../core/diagnostics/format-diagnostic.js";
import type { FileSystem } from "../../core/filesystem/filesystem.js";
import type { GitRepositoryLocator } from "../../core/git/git-repository-locator.js";
import {
  AtomicInitializationWriter,
  InitializationConflictError,
} from "../../core/initialization/atomic-writer.js";
import {
  commitInitialization,
  prepareInitialization,
  type InitializationPlan,
} from "../../core/initialization/initialize.js";
import { briefOncePath } from "../../core/initialization/paths.js";
import type { RepositoryMetadata } from "../../core/scanners/types.js";
import { productBrand } from "../../product-brand.js";
import { CliCommandError } from "../command-error.js";
import type { CliOutput } from "../output/cli-output.js";
import { writeLine } from "../output/cli-output.js";

export interface InitDependencies {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly agentfoldVersion: string;
}

interface InitCommandOptions {
  readonly dryRun?: boolean;
  readonly yes?: boolean;
}

function metadataLines(metadata: RepositoryMetadata): readonly string[] {
  const projects = [
    metadata.node.present ? "Node.js" : undefined,
    metadata.python.present ? "Python" : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(", ");

  return [
    `Project: ${metadata.repositoryName}`,
    `Detected stack: ${projects.length === 0 ? "none" : projects}`,
    `Package manager: ${metadata.packageManager ?? "not detected"}`,
    `Source directories: ${metadata.sourceDirectories.join(", ") || "none"}`,
    `Test directories: ${metadata.testDirectories.join(", ") || "none"}`,
    `Documentation directories: ${metadata.documentationDirectories.join(", ") || "none"}`,
    `Generated directories: ${metadata.generatedDirectories.join(", ") || "none"}`,
  ];
}

function writePlan(output: CliOutput, plan: InitializationPlan): void {
  writeLine(output, `${productBrand.productName} init`);
  writeLine(output);

  for (const diagnostic of plan.diagnostics) {
    writeLine(output, formatDiagnostic(diagnostic, { color: output.useColor }));
  }

  if (plan.repositoryRoot !== undefined) {
    writeLine(output);
    writeLine(output, `Repository root: ${plan.repositoryRoot}`);
  }

  if (plan.inspection !== undefined && plan.inspection.externalInstructionFiles.length > 0) {
    writeLine(output, "Existing agent instruction files (left untouched):");
    for (const file of plan.inspection.externalInstructionFiles) {
      writeLine(output, `  - ${file}`);
    }
  }

  if (plan.status === "ready") {
    writeLine(output);
    for (const line of metadataLines(plan.metadata)) {
      writeLine(output, line);
    }
    writeLine(output, "Files:");
    for (const file of plan.files) {
      writeLine(output, `  - ${briefOncePath(file.relativePath)}`);
    }
  }
}

export function registerInitCommand(
  program: Command,
  dependencies: InitDependencies,
  output: CliOutput,
): void {
  program
    .command("init")
    .description(`Safely initialize ${productBrand.productName} in an existing Git repository`)
    .addOption(
      new Option("--dry-run", "preview initialization without writing files").conflicts("yes"),
    )
    .addOption(new Option("--yes", "initialize non-interactively").conflicts("dryRun"))
    .action(async (options: InitCommandOptions) => {
      const plan = await prepareInitialization(dependencies);
      writePlan(output, plan);

      if (plan.exitCode !== 0) {
        throw new CliCommandError(
          plan.exitCode,
          `${productBrand.productName} initialization could not proceed`,
        );
      }

      if (plan.status !== "ready") {
        return;
      }

      if (options.yes === true) {
        let diagnostics: readonly Diagnostic[];
        try {
          diagnostics = await commitInitialization(
            plan,
            new AtomicInitializationWriter(dependencies.fileSystem),
          );
        } catch (error: unknown) {
          if (error instanceof InitializationConflictError) {
            writeLine(output);
            writeLine(
              output,
              formatDiagnostic(
                {
                  code: "AFI002",
                  severity: "error",
                  message:
                    "An initialization destination appeared before the atomic write completed.",
                  suggestion:
                    "No existing files were overwritten; inspect the destination and retry.",
                },
                { color: output.useColor },
              ),
            );
            throw new CliCommandError(5, error.message);
          }

          throw error;
        }
        const completion = diagnostics.at(-1);
        if (completion !== undefined) {
          writeLine(output);
          writeLine(output, formatDiagnostic(completion, { color: output.useColor }));
        }
        writeLine(output, `${productBrand.productName} initialized this repository.`);
        return;
      }

      writeLine(output);
      writeLine(
        output,
        options.dryRun === true
          ? "Dry run complete. No files were written."
          : "Preview complete. No files were written; re-run with --yes to initialize.",
      );
    });
}
