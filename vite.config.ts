const { defineConfig } = require("vite");
const react = require("@vitejs/plugin-react").default;

module.exports = defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/renderer"
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"]
  }
});
