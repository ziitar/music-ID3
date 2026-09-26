import { expect, test } from "./electron-fixture";
import type { Page } from "playwright/test";

async function scan(page: Page, expand = true) {
  await page.getByRole("button", { name: "Choose folder" }).click();
  await expect(page.getByRole("button", { name: "Expand directories" })).toBeVisible();
  if (expand) {
    await page.getByRole("button", { name: "Expand directories" }).click();
    await expect(page.getByTestId("directory-root")).not.toHaveText("No folder selected");
  }
}

test("catches progressive scan callbacks being replaced by final-summary replay", async ({ page }) => {
  await scan(page, false);

  await expect(page.locator(".directory-scan-indicator")).toBeVisible();
  await expect(page.getByTestId("library-count")).toHaveText("1 items");
  await expect(page.getByTestId("library-row")).toHaveCount(1);
  await expect(page.getByTestId("library-row").first()).toContainText("missing-file.cue");
  await expect(page.locator(".directory-scan-indicator")).toBeVisible();
});

test("catches a supported audio format or mixed-case extension disappearing from scan results", async ({ page, fixtureRoot }) => {
  await scan(page);

  await expect(page.getByTestId("library-count")).toHaveText("13 items");
  await expect(page.getByTestId("directory-root")).toHaveText(fixtureRoot);

  const expectedFormats = [
    ["editable.Mp3", "MP3"],
    ["disc.WaV", "WAV"],
    ["fixture.FlAc", "FLAC"],
    ["fixture.m4A", "M4A"],
    ["fixture.MP4", "MP4"],
    ["fixture.OgG", "OGG"],
    ["fixture.oPuS", "OPUS"],
    ["fixture.ApE", "APE"],
    ["fixture.Wv", "WV"]
  ] as const;
  for (const [fileName, format] of expectedFormats) {
    const row = page.getByTestId("library-row").filter({ has: page.getByText(fileName, { exact: true }) });
    await expect(row).toHaveCount(1);
    await expect(row.locator(".file-name")).toHaveText(fileName);
    await expect(row.locator(".format-copy strong")).toHaveText(format);
  }

  for (const fileName of ["editable.Mp3", "disc.WaV", "fixture.FlAc", "fixture.m4A", "fixture.MP4", "fixture.OgG", "fixture.oPuS", "fixture.ApE"]) {
    const row = page.getByTestId("library-row").filter({ has: page.getByText(fileName, { exact: true }) });
    await expect(row.locator(".format-copy small")).not.toHaveText("0:00");
  }
  await expect(page.getByTestId("library-row").filter({ hasText: "long-unassociated.MP3" })).toContainText("suspected");
  await expect(page.getByTestId("library-row").filter({ hasText: "missing-file.cue" })).toContainText("missing CUE refs");
  await expect(page.getByText("ignored.txt")).toHaveCount(0);
});

test("catches metadata details becoming editable before a suspected whole-track override", async ({ page }) => {
  await scan(page);
  await expect(page.getByTestId("library-count")).toHaveText("13 items");

  await page.getByTestId("library-row").filter({ hasText: "editable.Mp3" }).click();
  await expect(page.getByTestId("details-file-name")).toContainText("editable.Mp3");
  await expect(page.getByLabel("title value")).toHaveValue("Before E2E");
  await page.getByRole("button", { name: "Raw tags" }).click();
  await expect(page.getByTestId("raw-tags")).toContainText("Before E2E");

  await page.getByTestId("library-row").filter({ hasText: "long-unassociated.MP3" }).click();
  await page.getByRole("button", { name: "Common tags" }).click();
  await expect(page.getByText("Suspected whole-track CUE.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("title value")).toBeDisabled();
  await page.getByRole("button", { name: "Use normal audio editing" }).click();
  await expect(page.getByLabel("title value")).toBeEnabled();
  await expect(page.getByTestId("library-row").filter({ hasText: "long-unassociated.MP3" })).toContainText("overridden");
});
