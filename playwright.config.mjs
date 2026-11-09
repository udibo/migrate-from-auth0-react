import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

const { LOCAL_ISSUER, LOCAL_PROVIDER_PORT, provider } = await import("./e2e/provider.mjs");

const appPort = new URL(provider.appOrigin).port;
const apiPort = new URL(provider.apiOrigin).port;
const appEnv = {
  ...process.env,
  OAUTH_ISSUER: provider.issuer,
  OAUTH_CLIENT_ID: provider.clientId,
  OAUTH_AUDIENCE: provider.audience,
  APP_BASE_URL: provider.appOrigin,
  API_BASE_URL: provider.apiOrigin,
};

// The local identity provider, behind a proxy that adds the CORS headers a
// browser client needs and the provider does not send. Its issuer is the
// proxy's address, which is where the app and the API reach it.
const localProvider = [
  {
    command: `npx udibo-oauth2 idp dev --config e2e/idp.json --port ${LOCAL_PROVIDER_PORT} --issuer ${LOCAL_ISSUER}`,
    url: `http://127.0.0.1:${LOCAL_PROVIDER_PORT}/.well-known/openid-configuration`,
    reuseExistingServer: false,
  },
  {
    command: `node e2e/cors-proxy.mjs ${new URL(LOCAL_ISSUER).port} ${LOCAL_PROVIDER_PORT} ${provider.appOrigin}`,
    url: `${LOCAL_ISSUER}/.well-known/openid-configuration`,
    reuseExistingServer: false,
  },
];

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.mjs",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: provider.appOrigin,
    // A trace records what each step typed, the test password included.
    trace: process.env.CI ? "off" : "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  // The authorization server sends the browser back only to a registered URL;
  // e2e/provider.mjs says where the app and the API listen for each provider.
  webServer: [
    ...(provider.issuer === LOCAL_ISSUER ? localProvider : []),
    {
      command: "npm run build && node server.js",
      url: provider.appOrigin,
      env: { ...appEnv, SERVER_PORT: appPort },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "node api-server.js",
      url: `${provider.apiOrigin}/api/external`,
      env: { ...appEnv, API_PORT: apiPort },
      reuseExistingServer: false,
    },
  ],
});
