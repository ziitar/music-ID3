import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

type BuilderConfig = {
  npmRebuild?: boolean;
  asarUnpack?: string[];
  win?: {
    target?: Array<{ target?: string; arch?: string[] }>;
  };
};

describe("Windows packaging configuration", () => {
  it("rejects package directories metadata that electron-builder treats as deprecated config", () => {
    const packagePath = path.resolve(process.cwd(), "package.json");
    const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as { directories?: unknown };

    expect(manifest.directories).toBeUndefined();
  });

  it("rejects disabling npm rebuild, dropping NSIS/portable x64, or packing TagLib into ASAR", () => {
    const configPath = path.resolve(process.cwd(), "electron-builder.yml");
    const config = load(readFileSync(configPath, "utf8")) as BuilderConfig;

    expect(config.npmRebuild).toBe(true);
    expect(config.asarUnpack).toContain("node_modules/node-taglib-sharp/**/*");
    expect(config.win?.target).toEqual([
      { target: "nsis", arch: ["x64"] },
      { target: "portable", arch: ["x64"] }
    ]);
  });
});
