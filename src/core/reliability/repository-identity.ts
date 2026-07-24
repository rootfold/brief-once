import { createHash } from "node:crypto";

export function canonicalRepositoryId(
  canonicalRepositoryRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized =
    platform === "win32"
      ? canonicalRepositoryRoot.toLocaleLowerCase("en-US")
      : canonicalRepositoryRoot;
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 24);
}
