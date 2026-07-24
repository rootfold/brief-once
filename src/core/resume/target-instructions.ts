import type { ResumePacket, ResumeTarget } from "./types.js";

interface TargetDefinition {
  readonly displayName: string;
  readonly openingInstruction: string;
  readonly nativeInstructionFile?: "AGENTS.md" | "CLAUDE.md" | "GEMINI.md";
}

const targets: Readonly<Record<ResumeTarget, TargetDefinition>> = {
  codex: {
    displayName: "Codex",
    openingInstruction: "Continue this task from the validated BriefOnce checkpoint.",
    nativeInstructionFile: "AGENTS.md",
  },
  antigravity: {
    displayName: "Antigravity",
    openingInstruction: "Continue this task from the validated BriefOnce checkpoint.",
    nativeInstructionFile: "GEMINI.md",
  },
  claude: {
    displayName: "Claude",
    openingInstruction: "Continue this task from the validated BriefOnce checkpoint.",
    nativeInstructionFile: "CLAUDE.md",
  },
  gemini: {
    displayName: "Gemini",
    openingInstruction: "Continue this task from the validated BriefOnce checkpoint.",
    nativeInstructionFile: "GEMINI.md",
  },
  generic: {
    displayName: "Generic coding agent",
    openingInstruction: "Continue this task from the validated BriefOnce checkpoint.",
  },
};

export function nativeInstructionFileForTarget(
  target: ResumeTarget,
): TargetDefinition["nativeInstructionFile"] {
  return targets[target].nativeInstructionFile;
}

export function targetInstruction(
  target: ResumeTarget,
  availableInstructionFiles: readonly string[],
): NonNullable<ResumePacket["target"]> {
  const definition = targets[target];
  const nativeInstructionFile =
    definition.nativeInstructionFile !== undefined &&
    availableInstructionFiles.includes(definition.nativeInstructionFile)
      ? definition.nativeInstructionFile
      : undefined;

  return {
    id: target,
    displayName: definition.displayName,
    openingInstruction: definition.openingInstruction,
    ...(nativeInstructionFile === undefined ? {} : { nativeInstructionFile }),
  };
}
