/**
 * The authorization server the browser tests sign in through.
 *
 * E2E_PROVIDER=udibo uses the Udibo test tenant, from the UDIBO_* variables,
 * and E2E_PROVIDER=auth0 the Auth0 development tenant, from the AUTH0_*
 * variables; the Live tenant workflow runs both. Anything else uses
 * @udibo/oauth2's local identity provider, seeded from e2e/idp.json and
 * started by playwright.config.mjs, which needs no secrets.
 */
import { readFileSync } from "node:fs";

const env = process.env;
export const AUTH0_REQUIRED = ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_AUDIENCE", "AUTH0_TEST_USERNAME", "AUTH0_TEST_PASSWORD"];
export const UDIBO_REQUIRED = ["UDIBO_ISSUER", "UDIBO_CLIENT_ID", "UDIBO_AUDIENCE", "UDIBO_TEST_USERNAME", "UDIBO_TEST_PASSWORD"];

export const LOCAL_ISSUER = "http://127.0.0.1:9400";
export const LOCAL_PROVIDER_PORT = 9401;

// Auth0 sends the browser back only to its registered callback,
// http://localhost:3000. The local provider matches a 127.0.0.1 callback on
// any port, so a machine with something on 3000 can move the app.
const localPorts = { app: env.E2E_APP_PORT ?? "3000", api: env.E2E_API_PORT ?? "3001" };

function auth0() {
  const missing = AUTH0_REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`E2E_PROVIDER=auth0 needs ${missing.join(", ")}`);
  return {
    name: "Auth0",
    appOrigin: "http://localhost:3000",
    apiOrigin: "http://localhost:3001",
    issuer: `https://${env.AUTH0_DOMAIN}/`,
    origin: `https://${env.AUTH0_DOMAIN}`,
    clientId: env.AUTH0_CLIENT_ID,
    audience: env.AUTH0_AUDIENCE,
    username: env.AUTH0_TEST_USERNAME,
    password: env.AUTH0_TEST_PASSWORD,
    tokenEndpoint: `https://${env.AUTH0_DOMAIN}/oauth/token`,
    otherAudienceClient:
      env.AUTH0_OTHER_AUDIENCE_CLIENT_ID && env.AUTH0_OTHER_AUDIENCE_CLIENT_SECRET
        ? { id: env.AUTH0_OTHER_AUDIENCE_CLIENT_ID, secret: env.AUTH0_OTHER_AUDIENCE_CLIENT_SECRET }
        : null,
    subjectPattern: /^auth0\|/,
    profileClaim: "email",
    authorizePath: "/authorize",
    loginPathPattern: /^\/u\/login|^\/authorize/,
    endsSessionOnLogout: true,
    page: {
      username: 'input[name="username"]',
      password: 'input[name="password"]',
      submit: 'button[name="action"][value="default"]',
      accept: 'button[name="action"][value="accept"]',
      error: "#error-element-password, [data-error-code], .ulp-input-error-message",
    },
  };
}

function udibo() {
  const missing = UDIBO_REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`E2E_PROVIDER=udibo needs ${missing.join(", ")}`);
  const issuer = env.UDIBO_ISSUER.replace(/\/$/, "");
  return {
    name: "Udibo",
    appOrigin: "http://localhost:3000",
    apiOrigin: "http://localhost:3001",
    issuer,
    origin: new URL(issuer).origin,
    clientId: env.UDIBO_CLIENT_ID,
    audience: env.UDIBO_AUDIENCE,
    username: env.UDIBO_TEST_USERNAME,
    password: env.UDIBO_TEST_PASSWORD,
    tokenEndpoint: `${issuer}/api/oauth2/token`,
    otherAudienceClient:
      env.UDIBO_OTHER_AUDIENCE_CLIENT_ID && env.UDIBO_OTHER_AUDIENCE_CLIENT_SECRET
        ? { id: env.UDIBO_OTHER_AUDIENCE_CLIENT_ID, secret: env.UDIBO_OTHER_AUDIENCE_CLIENT_SECRET }
        : null,
    subjectPattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    // The test user signs in with a username and has no email address.
    profileClaim: "preferred_username",
    authorizePath: "/api/oauth2/authorize",
    loginPathPattern: /^\/sign-in/,
    endsSessionOnLogout: true,
    page: {
      username: 'input[name="identifier"]',
      password: 'input[name="password"]',
      submit: 'form:has(input[name="intent"][value="sign-in"]) button[type="submit"]',
      accept: 'button[name="consent"][value="approve"]',
      error: '[role="alert"]',
    },
  };
}

function local() {
  const seed = JSON.parse(readFileSync(new URL("./idp.json", import.meta.url), "utf8"));
  const [user] = seed.users;
  const [spa, other] = seed.clients;
  return {
    name: "the local identity provider",
    appOrigin: `http://127.0.0.1:${localPorts.app}`,
    apiOrigin: `http://127.0.0.1:${localPorts.api}`,
    issuer: LOCAL_ISSUER,
    origin: LOCAL_ISSUER,
    clientId: spa.id,
    audience: spa.audience,
    username: user.username,
    password: user.password,
    tokenEndpoint: `${LOCAL_ISSUER}/token`,
    otherAudienceClient: { id: other.id, secret: other.secret },
    subjectPattern: new RegExp(`^${user.id}$`),
    profileClaim: "email",
    authorizePath: "/authorize",
    loginPathPattern: /^\/authorize/,
    // It serves /logout but does not advertise it as end_session_endpoint
    // (udibo/oauth2#177), so the client can only sign out locally.
    endsSessionOnLogout: false,
    page: {
      username: "#username",
      password: "#password",
      submit: "#sign-in",
      accept: "#approve",
      error: "#sign-in-error",
    },
  };
}

const providers = { auth0, udibo };
export const provider = (providers[env.E2E_PROVIDER] ?? local)();
export const OTHER_AUDIENCE = "https://other-api.example";
