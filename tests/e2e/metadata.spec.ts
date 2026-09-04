import { stat } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "./electron-fixture";

async function openEditable(page: import("playwright/test").Page) {
  await page.getByRole("button", { name: "Choose folder" }).click();
  await expect(page.getByTestId("library-count")).toHaveText("13 items");
  await page.getByTestId("library-row").filter({ hasText: "editable.Mp3" }).click();
}

test("catches audio metadata writes that bypass per-field preview and confirmation", async ({ page, fixtureRoot }) => {
  await openEditable(page);
  await page.getByRole("checkbox", { name: "title", exact: true }).check();
  await page.getByRole("textbox", { name: "title value", exact: true }).fill("Confirmed E2E title");
  await page.getByRole("button", { name: "Preview diff" }).click();
  await expect(page.getByTestId("metadata-diff")).toContainText("Before E2E");
  await expect(page.getByTestId("metadata-diff")).toContainText("Confirmed E2E title");
  await page.getByRole("button", { name: "Write selected fields" }).click();
  await expect(page.getByRole("dialog")).toContainText("Confirm writing selected fields?");
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.getByTestId("library-row").filter({ hasText: "disc.WaV" }).click();
  await page.getByTestId("library-row").filter({ hasText: "editable.Mp3" }).click();
  await expect(page.getByRole("textbox", { name: "title value", exact: true })).toHaveValue("Before E2E");

  await page.getByRole("checkbox", { name: "title", exact: true }).check();
  await page.getByRole("textbox", { name: "title value", exact: true }).fill("Confirmed E2E title");
  await page.getByRole("button", { name: "Preview diff" }).click();
  await page.getByRole("button", { name: "Write selected fields" }).click();
  await page.getByRole("button", { name: "confirm write" }).click();
  await expect(page.getByRole("textbox", { name: "title value", exact: true })).toHaveValue("Confirmed E2E title");
  await page.getByTestId("library-row").filter({ hasText: "disc.WaV" }).click();
  await page.getByTestId("library-row").filter({ hasText: "editable.Mp3" }).click();
  await expect(page.getByRole("textbox", { name: "title value", exact: true })).toHaveValue("Confirmed E2E title");
  await expect(stat(`${path.join(fixtureRoot, "editable.Mp3")}.bak`)).rejects.toThrow();
});

test("catches provider candidates being written without a second explicit confirmation", async ({ page }) => {
  await openEditable(page);
  await page.getByLabel("candidate query").fill("Miles Davis Kind of Blue");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const candidate = page.getByTestId("metadata-candidate").filter({ hasText: "Kind of Blue" });
  await expect(candidate).toContainText("Miles Davis");
  await candidate.getByRole("button", { name: "Load candidate details" }).click();
  await expect(candidate.getByAltText("candidate cover")).toBeVisible();
  await candidate.getByRole("button", { name: "Apply candidate" }).click();
  await expect(page.getByRole("dialog")).toContainText("Review selected changes before writing.");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByTestId("library-row").filter({ hasText: "disc.WaV" }).click();
  await page.getByTestId("library-row").filter({ hasText: "editable.Mp3" }).click();
  await expect(page.getByRole("textbox", { name: "title value", exact: true })).toHaveValue("Before E2E");

  await page.getByRole("button", { name: "Search", exact: true }).click();
  const confirmedCandidate = page.getByTestId("metadata-candidate").filter({ hasText: "Kind of Blue" });
  await confirmedCandidate.getByRole("button", { name: "Load candidate details" }).click();
  await confirmedCandidate.getByRole("button", { name: "Apply candidate" }).click();
  await page.getByRole("button", { name: "confirm candidate write" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByTestId("library-row").filter({ hasText: "disc.WaV" }).click();
  await page.getByTestId("library-row").filter({ hasText: "editable.Mp3" }).click();
  await expect(page.getByRole("textbox", { name: "title value", exact: true })).toHaveValue("Kind of Blue");
  await expect(page.getByRole("textbox", { name: "artist value", exact: true })).toHaveValue("Miles Davis");
  await expect(page.getByRole("textbox", { name: "album value", exact: true })).toHaveValue("Kind of Blue");
});

test("catches provider failures leaking secrets or blocking later local writes", async ({ page }) => {
  await openEditable(page);
  await page.getByLabel("candidate query").fill("offline");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Metadata search failed");
  await expect(page.getByText("private-provider-token-must-not-render")).toHaveCount(0);

  await page.getByRole("checkbox", { name: "comment", exact: true }).check();
  await page.getByRole("textbox", { name: "comment value", exact: true }).fill("Local write after provider outage");
  await page.getByRole("button", { name: "Preview diff" }).click();
  await page.getByRole("button", { name: "Write selected fields" }).click();
  await page.getByRole("button", { name: "confirm write" }).click();
  await page.getByTestId("library-row").filter({ hasText: "disc.WaV" }).click();
  await page.getByTestId("library-row").filter({ hasText: "editable.Mp3" }).click();
  await expect(page.getByRole("textbox", { name: "comment value", exact: true })).toHaveValue("Local write after provider outage");
});

for (const provider of [
  { value: "netease", label: "NetEase", query: "Mystery of Love", title: "Mystery of Love", artist: "Sufjan Stevens", album: "Call Me by Your Name" },
  { value: "qq", label: "QQ Music", query: "Mojito", title: "Mojito", artist: "Jay Chou", album: "Mojito" }
] as const) {
  test(`completes the offline ${provider.label} candidate workflow`, async ({ page }) => {
    await openEditable(page);
    await page.getByLabel("provider", { exact: true }).selectOption(provider.value);
    await page.getByLabel("candidate query").fill(provider.query);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const candidate = page.getByTestId("metadata-candidate").filter({ hasText: provider.title });
    await expect(candidate).toContainText(provider.artist);
    await candidate.getByRole("button", { name: "Load candidate details" }).click();
    await expect(candidate.getByAltText("candidate cover")).toBeVisible();
    await candidate.getByRole("button", { name: "Apply candidate" }).click();
    await page.getByRole("button", { name: "confirm candidate write" }).click();
    await expect(page.getByRole("textbox", { name: "title value", exact: true })).toHaveValue(provider.title);
    await expect(page.getByRole("textbox", { name: "artist value", exact: true })).toHaveValue(provider.artist);
    await expect(page.getByRole("textbox", { name: "album value", exact: true })).toHaveValue(provider.album);
  });
}
