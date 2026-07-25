import { createHash } from "node:crypto";

import { briefOncePath } from "./paths.js";

export interface AgentFoldManifest {
  readonly schemaVersion: 1;
  readonly agentfoldVersion: string;
  readonly initializedAt: string;
  readonly repositoryRoot: ".";
  readonly generatedFiles: readonly string[];
  readonly hashes: Readonly<Record<string, string>>;
}

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function createManifest(
  generatedFiles: Readonly<Record<string, string>>,
  agentfoldVersion: string,
  initializedAt: Date,
): AgentFoldManifest {
  const paths = Object.keys(generatedFiles).sort((left, right) => left.localeCompare(right));
  const hashes = Object.fromEntries(
    paths.map((relativePath) => [
      briefOncePath(relativePath),
      sha256(generatedFiles[relativePath] ?? ""),
    ]),
  );

  return {
    schemaVersion: 1,
    agentfoldVersion,
    initializedAt: initializedAt.toISOString(),
    repositoryRoot: ".",
    generatedFiles: Object.keys(hashes),
    hashes,
  };
}

export function serializeManifest(manifest: AgentFoldManifest): string {
  return `${JSON.stringify(manifest, undefined, 2)}\n`;
}
