import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

export const tenantConfigured = ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_AUDIENCE", "AUTH0_TEST_USERNAME", "AUTH0_TEST_PASSWORD"].every(
  (name) => Boolean(process.env[name]),
);

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.mjs",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: "http://localhost:3000",
    // A trace records what each step typed, the test password included.
    trace: process.env.CI ? "off" : "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  // Auth0 sends the browser back only to a registered URL, so the app keeps
  // upstream's ports: the built app on 3000, the API on 3001.
  webServer: tenantConfigured
    ? [
        {
          command: "npm run build && node server.js",
          url: "http://localhost:3000",
          env: { SERVER_PORT: "3000" },
          reuseExistingServer: false,
          timeout: 120_000,
        },
        {
          command: "node api-server.js",
          port: 3001,
          env: { API_PORT: "3001" },
          reuseExistingServer: false,
        },
      ]
    : undefined,
});
