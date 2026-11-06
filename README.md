# Migrate from Auth0 to @udibo/oauth2 and Udibo

This repository takes Auth0's
[React single-page app quickstart](https://auth0.com/docs/quickstart/spa/react)
sample, `Sample-01` of
[`auth0-samples/auth0-react-samples`](https://github.com/auth0-samples/auth0-react-samples),
which signs in with [`@auth0/auth0-react`](https://github.com/auth0/auth0-react)
and calls an Express API that checks Auth0 access tokens. It moves the app to
[`@udibo/oauth2`](https://github.com/udibo/oauth2), still signing in through
Auth0, and then to Udibo's hosted identity service, one tagged step at a time.
Each step is a commit range you can read on its own; compare two tags to see
exactly what that step changes.

| Tag | What the app signs in with |
| --- | --- |
| `step-0-upstream` | The upstream sample: `@auth0/auth0-react` and Auth0 |
| `step-1-udibo-package` | `@udibo/oauth2`, still against Auth0 _(not yet published)_ |
| `step-2-udibo-idp` | `@udibo/oauth2` against Udibo's hosted identity service _(not yet published)_ |
| `step-3-user-import` | Users imported from Auth0 into Udibo _(not yet published)_ |

## Step 0: the upstream sample

The first commit copies `Sample-01` verbatim; [UPSTREAM.md](UPSTREAM.md)
records its source and license. The app is two processes: a React app built
with Vite (served on port 3000) that signs in through Auth0's Universal Login
page, and an Express API (port 3001) with one route, `GET /api/external`,
which accepts an Auth0 access token for its audience. As published, it builds
and runs; the commits after it change only this:

- **Dependencies:** unchanged. `npm ci` installs upstream's lockfile:
  `@auth0/auth0-react` 2.16.1 (on `@auth0/auth0-spa-js` 2.18.3), React 19.2.4,
  Vite 8.0.3, Express 4.22.1 and `express-oauth2-jwt-bearer` 1.7.4.
- **`.gitignore`:** ignores `dist/`, where Vite builds. Upstream's ignores
  `build/`, from before the sample moved to Vite.
- **Tests:** two suites, below, with `@playwright/test` 1.64.1 as the one new
  development dependency. `npm test` stays upstream's jest suite.

### What step 0 keeps from upstream

These are the sample's behaviours, kept because the migration changes them or
because they are the baseline it is compared with:

- **Tokens live in the browser's memory.** The SDK's defaults hold here: the
  access and ID tokens are cached in memory and no refresh token is requested.
  A page load starts with no tokens; the SDK then asks Auth0 again in a hidden
  iframe (`prompt=none`), which depends on the browser sending Auth0's session
  cookie to it (see the
  [auth0-react FAQ](https://github.com/auth0/auth0-react/blob/main/FAQ.md)).
  The tests move between pages through the app's links, not page loads.
- **The API checks only that a token is Auth0's, for its audience.**
  `express-oauth2-jwt-bearer` verifies the signature, issuer, audience and
  expiry; the route asks for no scope or permission, so any access token the
  tenant issues for this audience is accepted.
- **The API answers errors with stack traces** unless `NODE_ENV` is
  `production`: Express's default error handler renders the refusal with its
  stack, file paths included.
- **The API exits with status 0** when `AUTH0_DOMAIN` or `AUTH0_AUDIENCE` is
  missing, so a supervisor sees a clean exit, not a failure.
- **The production server sends no Content-Security-Policy:** `server.js`
  turns off helmet's.
- **`npm audit` reports 31 advisories** in upstream's lockfile (2 critical,
  10 high, 15 moderate, 4 low), most of them in the build and test tooling
  (Vite, jest, babel, nodemon) and some in what the servers run: `express`'s
  dependencies `body-parser`, `qs` and `proxy-addr` (critical), `morgan`, and
  `react-router-dom` 6.30.3 in the browser. Step 0 keeps them; a later step
  moves its own dependencies.

## Run it

Requirements: Node.js 22.12 or later, and an Auth0 tenant set up as in
[Set up the Auth0 tenant](#set-up-the-auth0-tenant).

```sh
npm ci
cp .env.example .env.local   # then fill in AUTH0_DOMAIN, AUTH0_CLIENT_ID and AUTH0_AUDIENCE
npm run dev                  # the app on http://localhost:3000, the API on :3001
```

`npm run prod` serves the built app (`npm run build` first) with `server.js`
instead of Vite's development server.

## Test

```sh
npm test                 # upstream's component tests (jest)
npm run test:behavior    # builds the app, then tests both servers; no tenant needed
npm run test:e2e         # signs in through the Auth0 tenant in Chromium
```

`npm run test:behavior` starts `api-server.js` and `server.js` as child
processes on free ports. Every request it makes is refused or answered before
the API reads the tenant's metadata, so it runs with a placeholder tenant:

| Area | What the tests pin |
| --- | --- |
| API configuration | Exits with status 0, serving nothing, without `AUTH0_DOMAIN`, without `AUTH0_AUDIENCE`, or with upstream's placeholder audience |
| API refusals | 401 with a `Bearer realm="api"` challenge without a token; 400 for an `Authorization` header that is not Bearer; 404 for any other path |
| API errors | The refusal carries the stack trace outside production, and not with `NODE_ENV=production` |
| API CORS | Names only `http://localhost:3000`, or `APP_BASE_URL` when set, whatever origin asks |
| App server | Every path answers with the built page; the built script is served; no Content-Security-Policy |

`npm run test:e2e` builds the app and starts it and the API on upstream's
ports, 3000 and 3001, because Auth0 returns the browser only to a registered
URL. It reads `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_AUDIENCE`,
`AUTH0_TEST_USERNAME` and `AUTH0_TEST_PASSWORD` from the environment or
`.env.local`, and skips every test when any is missing. It compares tenant
values in code, so a failure says what differed without printing them.
Nothing stands in for Auth0:

| Test | What it pins |
| --- | --- |
| Signed out | The home page offers to log in; `/profile` sends the browser to Auth0's login page |
| The sign-in request | `response_type=code` with `response_mode=query`, S256 PKCE, `state` and `nonce`, the `openid profile email` scopes, the API's audience, and the app's origin as `redirect_uri` |
| A wrong password | The user stays at Auth0, signed out |
| Profile | After signing in, the profile page shows the test user's email and an `auth0\|` subject |
| The API | Accepts the access token the app sends, a JWT from the tenant for the API's audience and this client, and refuses it with 401 `invalid_token` once its signature is altered |
| Logging out | Returns to the app signed out, and the next protected page asks Auth0 for the password again |

CI runs `npm test` and `npm run test:behavior` on Node 22 and 24 for every
push and pull request, with no secrets. The **Live tenant** workflow runs
`npm run test:e2e` against the tenant weekly and on demand, and reports that
it skipped while the secrets are missing. The daily run on a new
`@udibo/oauth2` release starts at step 1, the first step that depends on it.

## Set up the Auth0 tenant

Use a development tenant that holds synthetic users only. In the Auth0
dashboard:

1. **Application.** _Applications → Create Application_, type **Single Page
   Application**. In its settings:
   - _Allowed Callback URLs_, _Allowed Logout URLs_ and _Allowed Web Origins_:
     `http://localhost:3000`.
   - _Credentials_: authentication method **None** (the SPA default).
   - _Advanced → Grant Types_: **Authorization Code** (the default; leave the
     others as they are).
   - _Connections_: enable **Username-Password-Authentication** for it.
2. **API.** _Applications → APIs → Create API_, any name, the _Identifier_
   `https://migrate-from-auth0-react.example/api` (the audience; it is never
   fetched), signing algorithm **RS256**, and _Allow Skipping User Consent_
   on. If the tenant limits which applications may get user tokens for an
   API, allow this application.
3. **Test user.** _User Management → Users → Create User_ in
   **Username-Password-Authentication**, with a synthetic email address and a
   password, and mark the email verified. Sign in as it once yourself to see
   that no extra step appears.
4. **No extra sign-in steps.** _Security → Multi-factor Auth_: **Never** (or
   no factor enabled). _Security → Attack Protection → Bot Detection_: off,
   since a CAPTCHA stops an automated sign-in. Leave brute-force protection on:
   each run makes one wrong-password attempt, then signs in.
5. **Login experience.** Universal Login, the default. The tests fill the
   username and password fields on one page, or on two when the tenant asks
   for the identifier first. They accept Auth0's consent page when it
   appears: Auth0 shows it for a `localhost` callback even when the API
   allows skipping consent.

Then add these **repository secrets** (_Settings → Secrets and variables →
Actions_):

| Secret | Value |
| --- | --- |
| `AUTH0_DOMAIN` | The tenant's domain, such as `dev-abc123.us.auth0.com`, without `https://` |
| `AUTH0_CLIENT_ID` | The application's Client ID |
| `AUTH0_AUDIENCE` | The API's Identifier, `https://migrate-from-auth0-react.example/api` |
| `AUTH0_TEST_USERNAME` | The test user's email address |
| `AUTH0_TEST_PASSWORD` | The test user's password |

For a local run, put the same five names and values in `.env.local`, which
git ignores. The workflow passes the secrets only to the steps that check
for them and run the tests, and records no Playwright trace in CI, since a
trace includes what each step typed.

## Tested with

| Step | `@udibo/oauth2` | Node.js | Last live run |
| --- | --- | --- | --- |
| 0 | not used | 22, 24 (CI); 26 (locally) | not yet run: no tenant configured |

## The upstream sample's README

The README `Sample-01` ships with, unchanged except that its headings sit one
level lower and its relative link points at this repository's `LICENSE`:

## Auth0 React SDK Sample Application

This sample demonstrates the integration of [Auth0 React SDK](https://github.com/auth0/auth0-react) into a React application created using [Vite](https://vite.dev). The sample is a companion to the [Auth0 React SDK Quickstart](https://auth0.com/docs/quickstart/spa/react).

This sample demonstrates the following use cases:

- [Login](https://github.com/auth0-samples/auth0-react-samples/blob/master/Sample-01/src/components/NavBar.js#L72-L79)
- [Logout](https://github.com/auth0-samples/auth0-react-samples/blob/master/Sample-01/src/components/NavBar.js#L102-L108)
- [Showing the user profile](https://github.com/auth0-samples/auth0-react-samples/blob/master/Sample-01/src/views/Profile.js)
- [Protecting routes](https://github.com/auth0-samples/auth0-react-samples/blob/master/Sample-01/src/views/Profile.js#L33)
- [Calling APIs](https://github.com/auth0-samples/auth0-react-samples/blob/master/Sample-01/src/views/ExternalApi.js)

### Project setup

Use `npm` to install the project dependencies:

```bash
npm install
```

### Configuration

#### Create an API

For the ["call an API"](https://auth0.com/docs/quickstart/spa/react/02-calling-an-api) page to work, you will need to [create an API](https://auth0.com/docs/apis) using the [management dashboard](https://manage.auth0.com/#/apis). This will give you an API identifier that you can use as the `AUTH0_AUDIENCE` environment variable below.

If you do not wish to use an API or observe the API call working, you should not specify the `AUTH0_AUDIENCE` environment variable in the next step. Otherwise, you will receive a "Service not found" error when trying to authenticate.

#### Configure credentials

The project needs to be configured with your Auth0 domain and client ID in order for the authentication flow to work.

To do this, first copy `.env.example` into a new file in the same folder called `.env.local`, and replace the values with your own Auth0 application credentials, and optionally the base URLs of your application and API:

```bash
AUTH0_DOMAIN=your-tenant.us.auth0.com
AUTH0_CLIENT_ID=your-client-id
# AUTH0_AUDIENCE=your-api-identifier # optional, only needed for the External API feature

# APP_BASE_URL=https://your-app.com # optional, defaults work fine for local development
# API_BASE_URL=https://your-api-server.com # optional, defaults work fine for local development
```

**Note**: Do not specify a value for `AUTH0_AUDIENCE` here if you do not wish to use the API part of the sample.

### Run the sample

#### Compile and hot-reload for development

This compiles and serves the React app and starts the backend API server on port 3001.

```bash
npm run dev
```

### Deployment

#### Compiles and minifies for production

```bash
npm run build
```

#### Docker build

To build and run the Docker image, run `exec.sh`, or `exec.ps1` on Windows.

#### Run your tests

```bash
npm test
```

### Frequently Asked Questions

If you're having issues running the sample applications, including issues such as users not being authenticated on page refresh, please [check the auth0-react FAQ](https://github.com/auth0/auth0-react/blob/master/FAQ.md).

### What is Auth0?

Auth0 helps you to:

- Add authentication with [multiple sources](https://auth0.com/docs/identityproviders), either social identity providers such as **Google, Facebook, Microsoft Account, LinkedIn, GitHub, Twitter, Box, Salesforce** (amongst others), or enterprise identity systems like **Windows Azure AD, Google Apps, Active Directory, ADFS, or any SAML Identity Provider**.
- Add authentication through more traditional **[username/password databases](https://auth0.com/docs/connections/database/custom-db)**.
- Add support for **[linking different user accounts](https://auth0.com/docs/users/user-account-linking)** with the same user.
- Support for generating signed [JSON Web Tokens](https://auth0.com/docs/tokens/json-web-tokens) to call your APIs and **flow the user identity** securely.
- Analytics of how, when, and where users are logging in.
- Pull data from other sources and add it to the user profile through [JavaScript rules](https://auth0.com/docs/rules).

### Create a Free Auth0 Account

1. Go to [Auth0](https://auth0.com) and click **Sign Up**.
2. Use Google, GitHub, or Microsoft Account to login.

### Issue Reporting

If you have found a bug or if you have a feature request, please report them at this repository issues section. Please do not report security vulnerabilities on the public GitHub issue tracker. The [Responsible Disclosure Program](https://auth0.com/responsible-disclosure-policy) details the procedure for disclosing security issues.

### Author

[Auth0](https://auth0.com)

### License

This project is licensed under the MIT license. See the [LICENSE](LICENSE) file for more info.
