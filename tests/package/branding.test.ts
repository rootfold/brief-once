import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { productBrand } from "../../src/product-brand.js";

interface PackageMetadata {
  readonly name: string;
  readonly bin: Readonly<Record<string, string>>;
  readonly files: readonly string[];
  readonly repository: { readonly url: string };
}

describe("BriefOnce package branding", () => {
  it("keeps one CLI entry behind all four public aliases", async () => {
    const metadata = JSON.parse(
      await readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ) as PackageMetadata;

    expect(metadata.name).toBe("@rootfold/brief-once");
    expect(metadata.bin).toEqual({
      b1: "./dist/cli.js",
      briefonce: "./dist/cli.js",
      "brief-once": "./dist/cli.js",
      agentfold: "./dist/cli.js",
    });
    expect(new Set(Object.values(metadata.bin))).toEqual(new Set(["./dist/cli.js"]));
    expect(metadata.files).toEqual(["dist", "docs", "README.md"]);
    expect(metadata.repository.url).toBe("git+https://github.com/rootfold/brief-once.git");
  });

  it("centralizes the public name, tagline, commands, package, and repository", () => {
    expect(productBrand).toMatchObject({
      productName: "BriefOnce",
      tagline: "Brief once. Continue with any agent.",
      primaryCommand: "b1",
      fullCommand: "briefonce",
      packageCommand: "brief-once",
      legacyCommand: "agentfold",
      packageName: "@rootfold/brief-once",
      repository: "rootfold/brief-once",
      repositoryUrl: "https://github.com/rootfold/brief-once",
    });
  });

  it("preserves the Node shebang on the ESM CLI entry", async () => {
    const source = await readFile(path.join(process.cwd(), "src", "cli", "index.ts"), "utf8");
    expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });
});
