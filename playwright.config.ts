import { defineConfig } from "playwright/test";

const childEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name, value]) => name !== "NO_COLOR" && value !== undefined)
) as Record<string, string>;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  outputDir: "test-results/e2e",
  webServer: {
    command: "npm run build && npx vite --host 127.0.0.1 --port 5173",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: false,
    timeout: 120_000,
    env: childEnvironment
  }
});
