import {
  preferredProjectDirectory,
  preferredProjectRelativePath,
} from "../storage/project-storage.js";

export const briefOnceDirectory = preferredProjectDirectory;

export const initializationFilePaths = [
  "config.yaml",
  "context/project.md",
  "context/architecture.md",
  "context/commands.md",
  "context/conventions.md",
  "context/safety.md",
  "manifest.json",
] as const;

export const managedPayloadPaths = initializationFilePaths.filter(
  (file): file is Exclude<(typeof initializationFilePaths)[number], "manifest.json"> =>
    file !== "manifest.json",
);

export function briefOncePath(relativePath: string): string {
  return preferredProjectRelativePath(relativePath);
}

export function portablePath(input: string): string {
  return input.replaceAll("\\", "/");
}
