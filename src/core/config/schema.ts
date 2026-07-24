import { z } from "zod";

import { automationConfigSchema } from "./automation-policy.js";
import { reliabilityConfigSchema } from "./reliability-policy.js";
import { normalizeRepositoryPath, normalizeRepositoryPaths } from "./repository-path.js";

const nonEmptyString = z.string().trim().min(1, "Must not be empty");

const projectSchema = z
  .object({
    name: nonEmptyString.max(100, "Must be 100 characters or fewer"),
    summary: z.string().trim().max(1_000, "Must be 1000 characters or fewer"),
  })
  .strict();

const runtimeSchema = z
  .object({
    node: nonEmptyString.max(100, "Must be 100 characters or fewer"),
  })
  .strict();

const commandsSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9:_-]*$/u, "Must be a valid command name"),
  nonEmptyString,
);

const repositoryPathSchema = z.string().transform((value, context) => {
  const result = normalizeRepositoryPath(value);

  if (!result.success) {
    context.addIssue({ code: "custom", message: result.message });
    return z.NEVER;
  }

  return result.path;
});

const repositoryPathArraySchema = z
  .array(repositoryPathSchema)
  .transform((paths) => normalizeRepositoryPaths(paths));

const pathsSchema = z
  .object({
    source: repositoryPathArraySchema.optional(),
    tests: repositoryPathArraySchema.optional(),
    documentation: repositoryPathArraySchema.optional(),
    generated: repositoryPathArraySchema.optional(),
  })
  .strict();

const stateSchema = z
  .object({
    visibility: z.enum(["local", "tracked"]),
  })
  .strict();

const safetySchema = z
  .object({
    respect_gitignore: z.boolean(),
    excluded_paths: z.array(nonEmptyString).default([]),
  })
  .strict();

const adapterOptionsSchema = z.record(nonEmptyString, z.unknown());

export const agentFoldConfigSchema = z
  .object({
    version: z.literal(1),
    project: projectSchema,
    runtime: runtimeSchema,
    package_manager: z.enum(["pnpm", "npm", "yarn", "bun"]).optional(),
    commands: commandsSchema,
    paths: pathsSchema.optional(),
    state: stateSchema,
    safety: safetySchema,
    automation: automationConfigSchema.optional(),
    reliability: reliabilityConfigSchema.optional(),
    adapters: z.record(nonEmptyString, adapterOptionsSchema).optional(),
  })
  .strict();
