import type { z } from "zod";

import { agentFoldConfigSchema } from "./schema.js";
import type { AgentFoldConfig } from "./types.js";

export interface ConfigValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class ConfigValidationError extends Error {
  readonly issues: readonly ConfigValidationIssue[];

  constructor(error: z.ZodError) {
    const issues = error.issues.map((issue) => ({
      path: issue.path.length === 0 ? "<root>" : issue.path.map(String).join("."),
      message: issue.message,
    }));
    const details = issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n");

    super(`Invalid BriefOnce configuration:\n${details}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

export function parseConfig(input: unknown): AgentFoldConfig {
  const result = agentFoldConfigSchema.safeParse(input);

  if (!result.success) {
    throw new ConfigValidationError(result.error);
  }

  return result.data;
}
