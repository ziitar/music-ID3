import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "./electron-fixture";

async function scan(page: import("playwright/test").Page) {
  await page.getByRole("button", { name: "Choose folder" }).click();
  await expect(page.getByTestId("library-count")).toHaveText("12 items");
}

async function readText(filePath: string): Promise<string | undefined> {
  return readFile(filePath, "utf8").catch(() => undefined);
}

test("catches CUE reference diagnostics disappearing at the renderer boundary", async ({ page }) => {
  await scan(page);
  await page.getByTestId("library-row").filter({ hasText: "missing-file.cue" }).click();
  await expect(page.getByText("Missing references:", { exact: false })).toContainText("Ghost.FLAC");
  await expect(page.getByLabel("cue album title")).toHaveValue("Missing Album");
});

test("catches a CUE overwrite that does not preserve the original backup", async ({ page, fixtureRoot }) => {
  await scan(page);
  const cuePath = path.join(fixtureRoot, "valid.CuE");
  const original = await readFile(cuePath, "utf8");
  await page.getByTestId("library-row").filter({ hasText: "valid.CuE" }).click();
  await page.getByLabel("cue album title").fill("Edited Fixture Album");
  await page.getByRole("button", { name: "Save CUE" }).click();
  await expect(page.getByRole("dialog")).toContainText("Saving creates a .bak backup.");
  await expect(stat(`${cuePath}.bak`)).rejects.toThrow();
  await page.getByRole("button", { name: "Confirm CUE save" }).click();
  await expect(page.getByLabel("cue album title")).toHaveValue("Edited Fixture Album");
  await expect.poll(() => readText(`${cuePath}.bak`)).toBe(original);
  await expect.poll(() => readText(cuePath)).toContain('TITLE "Edited Fixture Album"');
});

test("catches a whole-track MusicBrainz match being written to audio instead of a new CUE", async ({ page, fixtureRoot }) => {
  await scan(page);
  await page.getByTestId("library-row").filter({ hasText: "long-unassociated.MP3" }).click();
  await page.getByLabel("candidate query").fill("Miles Davis Kind of Blue");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const candidate = page.getByTestId("metadata-candidate").filter({ hasText: "Kind of Blue" });
  await candidate.getByRole("button", { name: "Load candidate details" }).click();
  await expect(candidate.getByAltText("candidate cover")).toBeVisible();
  await candidate.getByRole("button", { name: "Apply candidate" }).click();
  await expect(page.getByText("Source: musicbrainz release", { exact: false })).toBeVisible();
  await expect(page.getByLabel("cue album title")).toHaveValue("Kind of Blue");
  await expect(page.getByLabel("track 1 title")).toHaveValue("So What");
  await page.getByRole("button", { name: "Save CUE" }).click();
  await page.getByRole("button", { name: "Confirm CUE save" }).click();

  const generatedPath = path.join(fixtureRoot, "long-unassociated.MP3.cue");
  await expect.poll(() => readText(generatedPath)).toContain('TITLE "Kind of Blue"');
  await expect(stat(`${generatedPath}.bak`)).rejects.toThrow();
  await expect(page.getByTestId("library-row").filter({ hasText: "long-unassociated.MP3.cue" })).toBeVisible();
});
