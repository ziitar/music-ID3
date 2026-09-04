import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "./electron-fixture";

test("keeps an encrypted provider Cookie configured across an application restart", async ({ page, relaunch, userDataPath }) => {
  const placeholderCookie = "MUSIC_U=e2e-placeholder-value";
  await page.getByText("Settings").click();
  await page.getByRole("textbox", { name: "cookie", exact: true }).fill(placeholderCookie);
  await page.getByRole("button", { name: "Save Cookie" }).click();
  await expect(page.getByLabel("Cookie status")).toHaveText("configured");

  const stored = await readFile(path.join(userDataPath, "provider-cookies.json"), "utf8");
  expect(stored).not.toContain(placeholderCookie);

  const relaunched = await relaunch();
  await relaunched.page.getByText("Settings").click();
  await expect(relaunched.page.getByLabel("Cookie status")).toHaveText("configured");
  await expect(relaunched.page.getByRole("textbox", { name: "cookie", exact: true })).toHaveValue("");
});
