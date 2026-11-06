import { expect, test } from "@playwright/test";
import { tenantConfigured } from "../playwright.config.mjs";

const {
  AUTH0_DOMAIN,
  AUTH0_CLIENT_ID,
  AUTH0_AUDIENCE,
  AUTH0_TEST_USERNAME,
  AUTH0_TEST_PASSWORD,
  AUTH0_OTHER_AUDIENCE_CLIENT_ID,
  AUTH0_OTHER_AUDIENCE_CLIENT_SECRET,
} = process.env;
const APP = "http://localhost:3000";
const API = "http://localhost:3001/api/external";
const OTHER_AUDIENCE = "https://other-api.example";

test.skip(!tenantConfigured, "No Auth0 tenant configured: set AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_AUDIENCE, AUTH0_TEST_USERNAME and AUTH0_TEST_PASSWORD");

const atAuth0 = (url) => url.hostname === AUTH0_DOMAIN;
const atApp = (url) => url.origin === APP;
const returnedWithError = (url) => atApp(url) && url.searchParams.has("error");

function failOnReturnedError(page) {
  const url = new URL(page.url());
  if (returnedWithError(url)) {
    throw new Error(`Auth0 sent the browser back with ${url.searchParams.get("error")}: ${url.searchParams.get("error_description")}`);
  }
}

/** Waits for Auth0's login page, failing at once when Auth0 sends the browser back to the app with an error instead. */
async function reachAuth0(page) {
  await page.waitForURL((url) => atAuth0(url) || returnedWithError(url));
  failOnReturnedError(page);
}

async function submitCredentials(page, password) {
  await reachAuth0(page);
  await page.locator('input[name="username"]').fill(AUTH0_TEST_USERNAME);
  const passwordField = page.locator('input[name="password"]');
  if (!(await passwordField.isVisible())) {
    await page.locator('button[name="action"][value="default"]').click();
  }
  await passwordField.fill(password);
  await page.locator('button[name="action"][value="default"]').click();
}

/** Signs in on Auth0's Universal Login page and accepts the consent page if Auth0 shows one. */
async function signIn(page) {
  await page.goto("/");
  await page.locator("#qsLoginBtn").first().click();
  await submitCredentials(page, AUTH0_TEST_PASSWORD);
  const accept = page.locator('button[name="action"][value="accept"]');
  await Promise.race([page.waitForURL(atApp), accept.waitFor()]);
  if (!atApp(new URL(page.url()))) {
    await accept.click();
    await page.waitForURL(atApp);
  }
  failOnReturnedError(page);
  await expect(page.locator("#profileDropDown")).toBeVisible();
}

// Assertions on tenant values compare them in code, so a failure names what
// differed without printing the value.

// The SDK keeps tokens in memory, so the tests move between pages through the
// app's own links: a full page load would start the session over.
async function openProfile(page) {
  await page.locator("#profileDropDown").click();
  await page.locator(".dropdown-profile").click();
  await page.waitForURL((url) => atApp(url) && url.pathname === "/profile");
}

async function pingApi(page) {
  await page.getByRole("link", { name: "External API" }).click();
  const request = page.waitForRequest(API);
  await page.getByRole("button", { name: "Ping API" }).click();
  const token = (await request).headers().authorization?.replace(/^Bearer /, "");
  return token;
}

function claims(jwt) {
  return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
}

test("signed out, the home page offers to log in and the protected pages send the browser to Auth0", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#qsLoginBtn").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "External API" })).toHaveCount(0);

  await page.goto("/profile");
  await reachAuth0(page);
  const authorize = new URL(page.url());
  expect(authorize.pathname).toMatch(/^\/u\/login|^\/authorize/);
  await expect(page.locator('input[name="username"]')).toBeVisible();
});

test("the sign-in request is an authorization-code request with PKCE, for the API's audience", async ({ page }) => {
  const authorizeRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return atAuth0(url) && url.pathname === "/authorize";
  });
  await page.goto("/");
  await page.locator("#qsLoginBtn").first().click();
  const url = new URL((await authorizeRequest).url());
  const params = Object.fromEntries(url.searchParams);
  expect(params.client_id === AUTH0_CLIENT_ID, "client_id is the application's").toBe(true);
  expect(params.audience === AUTH0_AUDIENCE, "audience is the API's identifier").toBe(true);
  const { redirect_uri, response_type, response_mode, code_challenge_method } = params;
  expect({ redirect_uri, response_type, response_mode, code_challenge_method }).toEqual({
    redirect_uri: APP,
    response_type: "code",
    response_mode: "query",
    code_challenge_method: "S256",
  });
  expect(params.scope.split(" ")).toEqual(expect.arrayContaining(["openid", "profile", "email"]));
  expect(Boolean(params.state) && Boolean(params.nonce), "state and nonce are present").toBe(true);
  expect(/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge), "code_challenge is an S256 digest").toBe(true);
});

test("a wrong password keeps the user at Auth0, signed out", async ({ page }) => {
  await page.goto("/");
  await page.locator("#qsLoginBtn").first().click();
  await submitCredentials(page, `${AUTH0_TEST_PASSWORD}-wrong`);
  await expect(page.locator("#error-element-password, [data-error-code], .ulp-input-error-message").first()).toBeVisible();
  expect(atAuth0(new URL(page.url()))).toBe(true);
});

test("signing in shows the user's profile", async ({ page }) => {
  await signIn(page);
  await openProfile(page);
  const shownEmail = await page.locator(".profile-header p.lead").innerText();
  expect(shownEmail === AUTH0_TEST_USERNAME, "the page shows the test user's email").toBe(true);
  const profile = JSON.parse(await page.locator("pre code").first().innerText());
  expect(profile.email === AUTH0_TEST_USERNAME, "the profile is the test user's").toBe(true);
  expect(profile.sub).toMatch(/^auth0\|/);
});

test("the API accepts the access token the app sends, and refuses it once altered", async ({ page, request }) => {
  await signIn(page);
  const token = await pingApi(page);
  await expect(page.getByTestId("api-result")).toContainText("Your access token was successfully validated!");

  expect(token?.split(".").length === 3, "the access token is a JWT").toBe(true);
  const payload = claims(token);
  expect(payload.iss === `https://${AUTH0_DOMAIN}/`, "the token's issuer is the tenant").toBe(true);
  expect([payload.aud].flat().includes(AUTH0_AUDIENCE), "the token is for the API's audience").toBe(true);
  expect(payload.azp === AUTH0_CLIENT_ID, "the token was issued to this application").toBe(true);

  const accepted = await request.get(API, { headers: { Authorization: `Bearer ${token}` } });
  expect(accepted.status()).toBe(200);
  expect(await accepted.json()).toEqual({ msg: "Your access token was successfully validated!" });

  const [header, body, signature] = token.split(".");
  const flipped = signature[0] === "A" ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
  const altered = await request.get(API, { headers: { Authorization: `Bearer ${header}.${body}.${flipped}` } });
  expect(altered.status()).toBe(401);
  expect(altered.headers()["www-authenticate"]).toContain('error="invalid_token"');
});

test("logging out returns to the app signed out, and ends the session at Auth0", async ({ page }) => {
  await signIn(page);
  await page.locator("#profileDropDown").click();
  await page.locator("#qsLogoutBtn").first().click();
  await page.waitForURL((url) => atApp(url) && url.pathname === "/");
  await expect(page.locator("#qsLoginBtn").first()).toBeVisible();

  await page.goto("/profile");
  await reachAuth0(page);
  await expect(page.locator('input[name="username"]')).toBeVisible();
});

test("the API refuses a token from the same tenant for another API", async ({ request }) => {
  test.skip(
    !AUTH0_OTHER_AUDIENCE_CLIENT_ID || !AUTH0_OTHER_AUDIENCE_CLIENT_SECRET,
    `No second API configured: set AUTH0_OTHER_AUDIENCE_CLIENT_ID and AUTH0_OTHER_AUDIENCE_CLIENT_SECRET for a machine-to-machine application authorized for ${OTHER_AUDIENCE}`,
  );
  const issued = await request.post(`https://${AUTH0_DOMAIN}/oauth/token`, {
    form: {
      grant_type: "client_credentials",
      client_id: AUTH0_OTHER_AUDIENCE_CLIENT_ID,
      client_secret: AUTH0_OTHER_AUDIENCE_CLIENT_SECRET,
      audience: OTHER_AUDIENCE,
    },
  });
  expect(issued.status(), "Auth0 issues the other API's token").toBe(200);
  const { access_token: token } = await issued.json();
  const payload = claims(token);
  expect(payload.iss === `https://${AUTH0_DOMAIN}/`, "the token's issuer is the same tenant").toBe(true);
  expect([payload.aud].flat().includes(OTHER_AUDIENCE), "the token is for the other API").toBe(true);
  expect([payload.aud].flat().includes(AUTH0_AUDIENCE), "the token is not for this API").toBe(false);

  const response = await request.get(API, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.status()).toBe(401);
  expect(response.headers()["www-authenticate"]).toContain('error="invalid_token"');
});
