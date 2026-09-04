import { expect, test } from "./electron-fixture";
import type { Page } from "playwright/test";

async function scan(page: Page) {
  await page.getByRole("button", { name: "Choose folder" }).click();
  await expect(page.getByTestId("directory-root")).not.toHaveText("No folder selected");
}

test("catches a scanner that stops streaming mixed-case files or CUE reference health", async ({ page, fixtureRoot }) => {
  await scan(page);

  await expect(page.getByTestId("scan-progress")).toBeVisible();
  await expect(page.getByTestId("library-row").first()).toBeVisible();
  await expect(page.getByTestId("scan-progress")).toBeVisible();
  await expect(page.getByTestId("library-count")).toHaveText("5 items");
  await expect(page.getByTestId("directory-root")).toHaveText(fixtureRoot);

  await expect(page.getByTestId("library-row").filter({ hasText: "editable.Mp3" })).toContainText("MP3");
  await expect(page.getByTestId("library-row").filter({ hasText: "disc.WaV" })).toContainText("WAV");
  await expect(page.getByTestId("library-row").filter({ hasText: "long-unassociated.MP3" })).toContainText("suspected");
  await expect(page.getByTestId("library-row").filter({ hasText: "missing-file.cue" })).toContainText("missing CUE refs");
  await expect(page.getByText("ignored.txt")).toHaveCount(0);
});

test("catches metadata details becoming editable before a suspected whole-track override", async ({ page }) => {
  await scan(page);
  await expect(page.getByTestId("library-count")).toHaveText("5 items");

  await page.getByTestId("library-row").filter({ hasText: "editable.Mp3" }).click();
  await expect(page.getByTestId("details-file-name")).toHaveText("editable.Mp3");
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
