import { expect, test } from "@playwright/test";
import { OTHER_AUDIENCE, provider } from "./provider.mjs";

const APP = provider.appOrigin;
const API = `${provider.apiOrigin}/api/external`;

const atProvider = (url) => url.origin === provider.origin;
const atApp = (url) => url.origin === APP;
const returnedWithError = (url) => atApp(url) && url.searchParams.has("error");

function failOnReturnedError(page) {
  const url = new URL(page.url());
  if (returnedWithError(url)) {
    throw new Error(`${provider.name} sent the browser back with ${url.searchParams.get("error")}: ${url.searchParams.get("error_description")}`);
  }
}

/** Waits for the provider's login page, failing at once when the provider sends the browser back to the app with an error instead. */
async function reachProvider(page) {
  await page.waitForURL((url) => atProvider(url) || returnedWithError(url));
  failOnReturnedError(page);
}

async function submitCredentials(page, password) {
  await reachProvider(page);
  await page.locator(provider.page.username).fill(provider.username);
  const passwordField = page.locator(provider.page.password);
  if (!(await passwordField.isVisible())) {
    await page.locator(provider.page.submit).click();
  }
  await passwordField.fill(password);
  await page.locator(provider.page.submit).click();
}

/** Signs in on the provider's login page and accepts a consent page if the provider shows one. */
async function signIn(page) {
  await page.goto("/");
  await page.locator("#qsLoginBtn").first().click();
  await submitCredentials(page, provider.password);
  const accept = page.locator(provider.page.accept);
  await Promise.race([page.waitForURL((url) => atApp(url) && !url.searchParams.has("state")), accept.waitFor()]);
  if (!atApp(new URL(page.url()))) {
    await accept.click();
  }
  await page.waitForURL((url) => (atApp(url) && !url.searchParams.has("state")) || returnedWithError(url));
  failOnReturnedError(page);
  await expect(page.locator("#profileDropDown")).toBeVisible();
}

// Assertions on tenant values compare them in code, so a failure names what
// differed without printing the value.

// The client keeps tokens in memory, so the tests move between pages through
// the app's own links: a full page load would start the session over.
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

test("signed out, the home page offers to log in and the protected pages send the browser to the provider", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#qsLoginBtn").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "External API" })).toHaveCount(0);

  await page.goto("/profile");
  await reachProvider(page);
  const authorize = new URL(page.url());
  expect(authorize.pathname).toMatch(provider.loginPathPattern);
  await expect(page.locator(provider.page.username)).toBeVisible();
});

test("the sign-in request is an authorization-code request with PKCE, for the API's audience", async ({ page }) => {
  const authorizeRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return atProvider(url) && url.pathname === provider.authorizePath;
  });
  await page.goto("/");
  await page.locator("#qsLoginBtn").first().click();
  const url = new URL((await authorizeRequest).url());
  const params = Object.fromEntries(url.searchParams);
  expect(params.client_id === provider.clientId, "client_id is the application's").toBe(true);
  expect(params.audience === provider.audience, "audience is the API's identifier").toBe(true);
  const { redirect_uri, response_type, response_mode, code_challenge_method } = params;
  // response_mode is left out: query is the default for response_type=code.
  expect({ redirect_uri, response_type, response_mode, code_challenge_method }).toEqual({
    redirect_uri: APP,
    response_type: "code",
    response_mode: undefined,
    code_challenge_method: "S256",
  });
  expect(params.scope.split(" ")).toEqual(expect.arrayContaining(["openid", "profile", "email"]));
  expect(Boolean(params.state), "state is present").toBe(true);
  expect(/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge), "code_challenge is an S256 digest").toBe(true);
});

test("a wrong password keeps the user at the provider, signed out", async ({ page }) => {
  await page.goto("/");
  await page.locator("#qsLoginBtn").first().click();
  await submitCredentials(page, `${provider.password}-wrong`);
  await expect(page.locator(provider.page.error).first()).toBeVisible();
  expect(atProvider(new URL(page.url()))).toBe(true);
});

test("signing in shows the user's profile", async ({ page }) => {
  await signIn(page);
  await openProfile(page);
  const profile = JSON.parse(await page.locator("pre code").first().innerText());
  expect(profile[provider.profileClaim] === provider.username, "the profile is the test user's").toBe(true);
  // The page's heading shows the email claim, which a username-only user lacks.
  if (provider.profileClaim === "email") {
    const shownEmail = await page.locator(".profile-header p.lead").innerText();
    expect(shownEmail === provider.username, "the page shows the test user's email").toBe(true);
  }
  expect(provider.subjectPattern.test(profile.sub), "the profile's subject is the provider's user id").toBe(true);
});

test("the API accepts the access token the app sends, and refuses it once altered", async ({ page, request }) => {
  await signIn(page);
  const token = await pingApi(page);
  await expect(page.getByTestId("api-result")).toContainText("Your access token was successfully validated!");

  expect(token?.split(".").length === 3, "the access token is a JWT").toBe(true);
  const payload = claims(token);
  expect(payload.iss === provider.issuer, "the token's issuer is the provider").toBe(true);
  expect([payload.aud].flat().includes(provider.audience), "the token is for the API's audience").toBe(true);
  // Auth0 names the client in azp; an RFC 9068 token, in client_id.
  expect((payload.azp ?? payload.client_id) === provider.clientId, "the token was issued to this application").toBe(true);

  const accepted = await request.get(API, { headers: { Authorization: `Bearer ${token}` } });
  expect(accepted.status()).toBe(200);
  expect(await accepted.json()).toEqual({ msg: "Your access token was successfully validated!" });

  const [header, body, signature] = token.split(".");
  const flipped = signature[0] === "A" ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
  const altered = await request.get(API, { headers: { Authorization: `Bearer ${header}.${body}.${flipped}` } });
  expect(altered.status()).toBe(401);
  expect(altered.headers()["www-authenticate"]).toContain('error="invalid_token"');
});

test("logging out returns to the app signed out, and ends the session at the provider", async ({ page }) => {
  await signIn(page);
  // The app is already on / when logout starts, so waiting for / alone would
  // pass before the browser has been to the provider's end-session endpoint.
  const leftForProvider = provider.endsSessionOnLogout
    ? page.waitForRequest((request) => request.isNavigationRequest() && atProvider(new URL(request.url())))
    : null;
  await page.locator("#profileDropDown").click();
  await page.locator("#qsLogoutBtn").first().click();
  if (leftForProvider) {
    await leftForProvider;
    await page.waitForEvent("framenavigated", {
      predicate: (frame) => frame === page.mainFrame() && atApp(new URL(frame.url())),
    });
  }
  await page.waitForURL((url) => atApp(url) && url.pathname === "/");
  await expect(page.locator("#qsLoginBtn").first()).toBeVisible();

  if (!provider.endsSessionOnLogout) {
    test.info().annotations.push({
      type: "not checked",
      description: `${provider.name} advertises no end_session_endpoint (udibo/oauth2#177), so the client signs out locally only`,
    });
    return;
  }
  await page.goto("/profile");
  await reachProvider(page);
  await expect(page.locator(provider.page.username)).toBeVisible();
});

test("the API refuses a token from the same provider for another API", async ({ request }) => {
  const other = provider.otherAudienceClient;
  test.skip(
    !other,
    `No second API configured: set AUTH0_OTHER_AUDIENCE_CLIENT_ID and AUTH0_OTHER_AUDIENCE_CLIENT_SECRET for a machine-to-machine application authorized for ${OTHER_AUDIENCE}`,
  );
  const issued = await request.post(provider.tokenEndpoint, {
    form: {
      grant_type: "client_credentials",
      client_id: other.id,
      client_secret: other.secret,
      audience: OTHER_AUDIENCE,
    },
  });
  expect(issued.status(), "the provider issues the other API's token").toBe(200);
  const { access_token: token } = await issued.json();
  const payload = claims(token);
  expect(payload.iss === provider.issuer, "the token's issuer is the same provider").toBe(true);
  expect([payload.aud].flat().includes(OTHER_AUDIENCE), "the token is for the other API").toBe(true);
  expect([payload.aud].flat().includes(provider.audience), "the token is not for this API").toBe(false);

  const response = await request.get(API, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.status()).toBe(401);
  expect(response.headers()["www-authenticate"]).toContain('error="invalid_token"');
});
