const { defineConfig } = require("vite");
const react = require("@vitejs/plugin-react").default;

module.exports = defineConfig({
  // Packaged renderer pages use file://, so their assets must stay relative to index.html.
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist/renderer"
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"]
  }
});
