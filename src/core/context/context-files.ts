import {
  preferredProjectDirectory,
  projectStorageRelativePath,
  type ProjectStorageDirectory,
} from "../storage/project-storage.js";

export const canonicalContextFileNames = {
  project: "project.md",
  architecture: "architecture.md",
  commands: "commands.md",
  conventions: "conventions.md",
  safety: "safety.md",
} as const;

export type CanonicalContextFileName = keyof typeof canonicalContextFileNames;

export function canonicalContextFiles(
  directory: ProjectStorageDirectory = preferredProjectDirectory,
): Readonly<Record<CanonicalContextFileName, string>> {
  return Object.fromEntries(
    Object.entries(canonicalContextFileNames).map(([name, fileName]) => [
      name,
      projectStorageRelativePath(directory, `context/${fileName}`),
    ]),
  ) as Readonly<Record<CanonicalContextFileName, string>>;
}

export function canonicalContextFileEntries(
  directory: ProjectStorageDirectory = preferredProjectDirectory,
): readonly (readonly [CanonicalContextFileName, string])[] {
  return Object.entries(canonicalContextFiles(directory)) as readonly (readonly [
    CanonicalContextFileName,
    string,
  ])[];
}
