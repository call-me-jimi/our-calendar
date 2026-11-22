import { defineConfig } from "@playwright/test";

// End-to-end tests against the running stack (`make up`), not the Vite dev server.
export default defineConfig({
  testDir: "e2e",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "https://wann.localhost:8444",
    // Caddy's local CA on the laptop; a real certificate on the server.
    ignoreHTTPSErrors: !process.env.E2E_BASE_URL,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
