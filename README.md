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
| `step-1-udibo-package` | `@udibo/oauth2`, still against Auth0 |
| `step-2-udibo-idp` | `@udibo/oauth2` against Udibo's hosted identity service |
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
- **The API exits with status 0** when its domain or audience is missing, so
  a supervisor sees a clean exit, not a failure.
- **The production server sends no Content-Security-Policy:** `server.js`
  turns off helmet's.
- **`npm audit` reports 31 advisories** in upstream's lockfile (2 critical,
  10 high, 15 moderate, 4 low), most of them in the build and test tooling
  (Vite, jest, babel, nodemon) and some in what the servers run: `express`'s
  dependencies `body-parser`, `qs` and `proxy-addr` (critical), `morgan`, and
  `react-router-dom` 6.30.3 in the browser. Step 0 keeps them; step 1
  upgrades its dependencies.

## Step 1: @udibo/oauth2, still signing in through Auth0

Step 1 replaces `@auth0/auth0-react` with
[`@udibo/oauth2`](https://github.com/udibo/oauth2) 0.51.0 and changes nothing
at Auth0: the same application, API, user and settings as step 0. It is the
first half of the switch: the app now runs on a provider-neutral OAuth2
client, so step 2 can move it to Udibo by changing configuration.

### What changes in the app

| Step 0 (`@auth0/auth0-react`) | Step 1 (`@udibo/oauth2`) |
| --- | --- |
| `<Auth0Provider domain clientId authorizationParams>` | `<OAuth2Provider client>` with a `DirectClient` (`src/auth.js`): a public client with PKCE (S256) and `state`, pending sign-ins in `sessionStorage`, tokens in memory |
| The SDK completes the sign-in on whichever page Auth0 returns to | The home route renders `<OAuth2Callback>` when it carries `code` (or `error`) and `state`, then navigates to where the sign-in started |
| `useAuth0()` | `useOAuth2()` for the user, `isLoading`, `error`, `login` and `logout`; `useDirectClient()` for the access token |
| `withAuthenticationRequired(Component)` | `<RequireAuth fallback={<Loading />}>` around the component |
| `getAccessTokenSilently()` | `client.getAccessToken()` |
| `loginWithPopup()` and `getAccessTokenWithPopup()` on the API page | A redirect sign-in that comes back to the page (`login({ returnTo })`, and `prompt=consent` for consent): the package has no pop-up flow |
| `logout({ logoutParams: { returnTo } })` | `logout({ returnTo })`, which sends the browser to the tenant's `end_session_endpoint` (`/oidc/logout`) with `id_token_hint` and `post_logout_redirect_uri` |
| `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_AUDIENCE` | `OAUTH_ISSUER` (for Auth0, `https://<domain>/`), `OAUTH_CLIENT_ID`, `OAUTH_AUDIENCE`, read by both the app and the API |

`DirectClient` takes no default authorization-request parameter, and
`RequireAuth` and `useOAuth2().login()` pass only `returnTo`, so `src/auth.js`
subclasses it to add `audience` to every sign-in
([udibo/oauth2#189](https://github.com/udibo/oauth2/issues/189)). Without
`audience`, Auth0 issues an opaque access token for its own `/userinfo`
endpoint, as its documentation describes, which the API cannot verify.

**The API stays on `express-oauth2-jwt-bearer`.** Moving it to the package's
resource server (`ExpressResourceServer` with `JwksTokenReader`) needs an Auth0
change: the tenant's access tokens use Auth0's default token profile, with
`typ: JWT` and no `client_id` or `jti` claim, and `JwksTokenReader` accepts
only RFC 9068 tokens (`typ: at+jwt`, with both claims). Switching the API's
token profile to RFC 9068 in the Auth0 dashboard would allow it; step 1
changes nothing at Auth0, so the API moves when its issuer does. The API now
takes the issuer URL (`OAUTH_ISSUER`) instead of a domain, so it can also check
the local identity provider's tokens in CI. Its `algorithms: ["RS256"]` is
upstream's and, as before, has no effect: `express-oauth2-jwt-bearer`'s option
is `tokenSigningAlg`, so the API accepts any asymmetric algorithm the issuer's
keys support, which is how it accepts the local provider's ES256 tokens.

### Behaviour that changes

- **No `nonce` and no `response_mode` in the sign-in request.**
  `DirectClient` relies on PKCE and `state` for the code flow; `response_mode`
  was `query`, the default for `response_type=code`. The client decodes the
  ID token from its own token request rather than verifying its signature,
  which OpenID Connect allows for a token received directly over TLS.
- **A page load starts signed out.** Tokens are in memory, and Auth0 returns
  no refresh token to a sign-in without `offline_access` (none came back to
  this tenant's sign-in), so a reload has nothing to resume from, and the client does not ask Auth0 again in a hidden iframe as Auth0's
  SDK did. A protected page starts a sign-in, which Auth0 completes without a
  password while its session lasts. Keeping a session across reloads would
  need refresh tokens: `offline_access`, _Allow Offline Access_ on the Auth0
  API, refresh-token rotation for the application, and
  `IndexedDBRefreshTokenStorage`.
- **An expired access token needs a new sign-in.** With no refresh token, the
  API page reports `login_required` and offers to log in again by redirect.

### What Auth0 still needs to be configured with

This is the list of Auth0-specific settings the app depends on at step 1,
each of which a move to another provider has to replace:

- **The `audience` parameter** on every sign-in, or Auth0 issues an opaque
  access token for `/userinfo` only, which the API cannot verify. The app adds
  it in `src/auth.js`, and the sign-in request test checks it is sent.
- **The application authorized for the API with user access** (the
  application's **APIs** tab), or Auth0 sends sign-in back with
  `Client "…" is not authorized to access resource server "…"`.
- **`http://localhost:3000` in Allowed Callback URLs, Allowed Logout URLs and
  Allowed Web Origins.** The last lets the browser call `/oauth/token` across
  origins; Auth0's discovery documents send `Access-Control-Allow-Origin: *`.
- **The `end_session_endpoint`** in discovery, which RP-Initiated Logout needs.
  This tenant advertises it (`/oidc/logout`), so logout needs no Auth0-specific
  call. A tenant that does not would leave the client signing out locally
  only, with Auth0's session still open.
- **An API with RS256 signing**, whose access tokens use Auth0's token profile
  (`typ: JWT`, `azp` for the client, no `client_id` or `jti`).
- **Consent:** Auth0 shows its consent page for a `localhost` callback even
  with _Allow Skipping User Consent_ on.

Ruled out: discovery needs nothing special. Auth0 serves both
`/.well-known/openid-configuration` and
`/.well-known/oauth-authorization-server`, its issuer
(`https://<domain>/`, with the trailing slash) matches what the client
expects, and it advertises S256 PKCE. Auth0 does not send `iss` in the
authorization response (RFC 9207) and does not advertise it, so the client
accepts the response without one.

### A backend-for-frontend later?

The package's recommended shape for a browser app is a backend-for-frontend
(`HonoBff` with `BffClient`), which keeps tokens on a server behind an HttpOnly
cookie and ends the reload problem above. It is worth an optional later step:
it changes the app's architecture (a server that holds sessions, and the API
called through it), which is more than this migration's steps are meant to
carry. Steps 2 and 3 keep the single-page shape so their diffs stay
configuration and data.

### Dependencies

Every dependency is now pinned to an exact version, upgraded to the newest
release at least two weeks old within its major version. React Router moves
to 7.18.4, a major version, because 6.x has no release without its
advisories; the app's imports are unchanged. `npm audit` drops from 31
advisories to 20 (3 low, 17 moderate, none high or critical), all in
development tools with no fixed release in their major versions: jest's
`glob`, `minimatch`, `test-exclude` and `deepmerge`, and nodemon's
`minimatch`. `npm audit --omit=dev` reports none.

## Step 2: sign in through Udibo

Step 2 points the app at a Udibo tenant. **No line of the app or the API
changes**: both read their issuer, client and audience from `OAUTH_ISSUER`,
`OAUTH_CLIENT_ID` and `OAUTH_AUDIENCE` since step 1, so the move is those three
values:

| Setting | Auth0 (step 1) | Udibo (step 2) |
| --- | --- | --- |
| `OAUTH_ISSUER` | `https://<tenant>.us.auth0.com/` | The tenant's issuer, such as `https://<tenant id>.udibo.com`, with no trailing slash |
| `OAUTH_CLIENT_ID` | The Auth0 application's Client ID | The Udibo application's client ID |
| `OAUTH_AUDIENCE` | The Auth0 API's Identifier | The Udibo application's access-token audience, `https://migrate-from-auth0-react.example/api` |

The rest of the step is the test harness, the live workflow and this README.

### What Udibo needs to be configured with

See [Set up the Udibo tenant](#set-up-the-udibo-tenant) for the steps. Compared
with Auth0's list in step 1:

- **The audience belongs to the application.** Udibo issues JWT access tokens
  for the audience set on the application (RFC 9068 `at+jwt`, ES256, with
  `client_id` and `jti`). It ignores the `audience` parameter the client still
  sends for Auth0. There is no separate API object to authorize the
  application for.
- **The callback and logout URLs** are the application's redirect URI and
  post-logout redirect URI, `http://localhost:3000`, on a **Development**
  application, which is what allows `http` on `localhost`.
- **Cross-origin calls** need no setting. Udibo answers CORS on its discovery
  documents and JWKS for any origin. On `/api/oauth2/token`, `/userinfo` and
  `/revoke` it answers only an origin registered as a redirect URI of a
  **public** application in the same tenant. A confidential client's origins
  get no CORS.
- **Logout** uses the advertised `end_session_endpoint`
  (`/api/oauth2/end_session`), with the same `id_token_hint` and
  `post_logout_redirect_uri` as at Auth0.
- **RFC 9207:** Udibo sends `iss` in the authorization response and
  advertises it, so the client checks it. Auth0 sent none.
- **Consent:** a first-party application gets no consent page.

### Findings

- **Udibo did not answer CORS for a browser-only client until 2026-11-09.**
  Before udibo/udibo#3280, none of the discovery documents, `/token`,
  `/userinfo` or `/revoke` sent `Access-Control-Allow-Origin`, and every
  preflight got 404. A single-page app could not discover the issuer or
  redeem its code, though Udibo's documentation listed browser-only public
  clients as supported. The fix answers CORS as described above. This step
  was checked against an in-process Udibo at that commit, from
  `http://localhost:3000` with a public Development application:
  - discovery, the code exchange, UserInfo and revocation all succeed, with
    the app's origin named and no credentials allowed;
  - a preflight asking to send `Authorization` to `/token` is refused;
  - an unregistered origin gets no CORS answer.
- **A username-only user has no email.** Udibo's test user signs in with a
  username, so its ID token and UserInfo carry `preferred_username` and no
  `email`. The profile page's heading shows the `email` claim and is empty
  for this user; the app is unchanged, and the profile test compares
  `preferred_username` at Udibo instead.
- **The API needs no change.** `express-oauth2-jwt-bearer` checks Udibo's
  ES256 `at+jwt` tokens against the issuer's JWKS as it checked Auth0's.
  Moving the API to `@udibo/oauth2`'s `JwksTokenReader`, which step 1 could
  not do against Auth0's token profile, is now possible but is not
  configuration, so it is left out of this step.

### The client switch-over

Udibo does not import Auth0's client IDs or credentials. Register a new
public application in Udibo, as in [Set up the Udibo
tenant](#set-up-the-udibo-tenant), and deploy the app with the three settings
above. During the move:

1. **The API accepts tokens from both issuers.** One
   `express-oauth2-jwt-bearer` middleware checks one issuer, so mount one per
   issuer and accept a request either one accepts, or run a second instance of
   the API for the Udibo client.
2. **Clients move one at a time.** This example has one client: the
   single-page app.
3. **Auth0 is turned off** once the last client has moved and its tokens have
   expired. A single-page app holds no refresh token from Auth0 (step 1
   requested none), so that is the access-token lifetime, 24 hours by default.

Until step 3 imports the users, an Auth0 user has no Udibo account and cannot
sign in through Udibo.

### Live tests at step 2

The **Live tenant** workflow now runs the browser tests against both tenants,
one job each. The Udibo job is this step's evidence. The Auth0 job stays as
the rollback check: the same code, configured for Auth0, still signs in, so
the move can be reverted by configuration while users and clients are still
moving. It can be dropped once step 3 has retired the Auth0 tenant. Each job
skips, and says so, until its own secrets are set.

## Run it

Requirements: Node.js 22.12 or later, and a Udibo tenant set up as in
[Set up the Udibo tenant](#set-up-the-udibo-tenant) (or, to run it as step 1
did, an Auth0 tenant set up as in [Set up the Auth0
tenant](#set-up-the-auth0-tenant)).

```sh
npm ci
cp .env.example .env.local   # then fill in OAUTH_ISSUER, OAUTH_CLIENT_ID and OAUTH_AUDIENCE
npm run dev                  # the app on http://localhost:3000, the API on :3001
```

For Udibo, `OAUTH_ISSUER` is the tenant's issuer, `OAUTH_CLIENT_ID` the
application's client ID, and `OAUTH_AUDIENCE` its access-token audience. For
Auth0, `OAUTH_ISSUER` is `https://<your tenant's domain>/`, with the trailing
slash, `OAUTH_CLIENT_ID` the application's Client ID, and `OAUTH_AUDIENCE` the
API's Identifier.

`npm run prod` serves the built app (`npm run build` first) with `server.js`
instead of Vite's development server.

## Test

```sh
npm test                 # upstream's component tests (jest)
npm run test:behavior    # builds the app, then tests both servers; no tenant needed
npm run test:e2e         # signs in through the local identity provider in Chromium
E2E_PROVIDER=udibo npm run test:e2e   # the same tests, through the Udibo tenant
E2E_PROVIDER=auth0 npm run test:e2e   # the same tests, through the Auth0 tenant
```

`npm run test:behavior` starts `api-server.js` and `server.js` as child
processes on free ports. Every request it makes is refused or answered before
the API reads the issuer's metadata, so it runs with a placeholder issuer. It
sets every variable the sample reads, empty where a test needs it unset, so a
filled `.env.local` cannot change what it tests:

| Area | What the tests pin |
| --- | --- |
| API configuration | Exits with status 0, serving nothing, without `OAUTH_ISSUER`, without `OAUTH_AUDIENCE`, or with upstream's placeholder audience; reads `.env.local` only for what the environment leaves unset |
| API refusals | 401 with a `Bearer realm="api"` challenge without a token; 400 for an `Authorization` header that is not Bearer; 404 for any other path |
| API errors | The refusal carries the stack trace outside production, and not with `NODE_ENV=production` |
| API CORS | Names only `http://localhost:3000`, or `APP_BASE_URL` when set, whatever origin asks |
| App server | Every path answers with the built page; the built script is served; no Content-Security-Policy |

`npm run test:e2e` builds the app, starts it and the API, and signs in in
Chromium through one of three authorization servers, chosen by `E2E_PROVIDER`:

- **By default, `@udibo/oauth2`'s local identity provider** (`udibo-oauth2 idp
  dev`), seeded from `e2e/idp.json` with a synthetic user and two clients, and
  started by the test run. It needs no secrets, and CI runs it on every push.
  The provider sends no CORS headers, so a browser client on another origin
  cannot call it ([udibo/oauth2#190](https://github.com/udibo/oauth2/issues/190));
  the tests put a small proxy in front of it (`e2e/cors-proxy.mjs`) that adds
  them for the app's origin and passes everything else through. The app runs
  on `http://127.0.0.1:3000` here, or on `E2E_APP_PORT` and `E2E_API_PORT`
  when 3000 and 3001 are taken.
- **With `E2E_PROVIDER=udibo`, the Udibo tenant**, on ports 3000 and 3001,
  the application's registered URL. It reads `UDIBO_ISSUER`,
  `UDIBO_CLIENT_ID`, `UDIBO_AUDIENCE`, `UDIBO_TEST_USERNAME` and
  `UDIBO_TEST_PASSWORD`, and refuses to start without them.
- **With `E2E_PROVIDER=auth0`, the Auth0 tenant**, on upstream's ports 3000
  and 3001, because Auth0 returns the browser only to a registered URL. It
  reads `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_AUDIENCE`,
  `AUTH0_TEST_USERNAME` and `AUTH0_TEST_PASSWORD` from the environment or
  `.env.local`, and refuses to start without them.

The tests compare tenant values in code, so a failure says what differed
without printing them, and fail at once, with the provider's `error` and
`error_description`, when it sends the browser back to the app with an error
instead of showing its login page. Nothing stands in for any provider:

| Test | What it pins |
| --- | --- |
| Signed out | The home page offers to log in; `/profile` sends the browser to the provider's login page |
| The sign-in request | `response_type=code` (no `response_mode`: `query` is the default), S256 PKCE, `state`, the `openid profile email` scopes, the API's audience, and the app's origin as `redirect_uri` |
| A wrong password | The user stays at the provider, signed out |
| Profile | After signing in, the profile shows the test user (its `email`, or at Udibo, whose test user has none, its `preferred_username`) and the provider's subject (`auth0\|…` at Auth0, a UUID at Udibo); where the user has an email, the page's heading shows it |
| The API | Accepts the access token the app sends, a JWT from the provider for the API's audience and this client, and refuses it with 401 `invalid_token` once its signature is altered |
| Logging out | Returns to the app signed out, and the next protected page asks the provider for the password again. The local provider advertises no `end_session_endpoint` ([udibo/oauth2#177](https://github.com/udibo/oauth2/issues/177)), so there only the local sign-out is checked: the redirect to the end-session endpoint, with `id_token_hint` and `post_logout_redirect_uri`, is exercised only by the Auth0 and Udibo runs |
| Another API's token | A client-credentials token from the same provider for `https://other-api.example` gets 401 `invalid_token`. At Auth0 it needs `AUTH0_OTHER_AUDIENCE_CLIENT_ID` and `AUTH0_OTHER_AUDIENCE_CLIENT_SECRET`, at Udibo `UDIBO_OTHER_AUDIENCE_CLIENT_ID` and `UDIBO_OTHER_AUDIENCE_CLIENT_SECRET`, and skips alone without them |

CI runs `npm test`, `npm run test:behavior` and `npm run test:e2e` (through
the local identity provider) on Node 22 and 24 for every push and pull
request, with no secrets. The **Live tenant** workflow runs the browser tests
against the Udibo tenant and the Auth0 tenant, one job each, every Monday and
on demand, with the pinned `@udibo/oauth2`. On the other days it checks npm for a newer `@udibo/oauth2`
and, the first day one appears, installs and tests it against each tenant,
so a release that breaks sign-in shows up the day it is published. A release
that passed against a tenant is recorded in the workflow's cache and not
tested there again; one that failed is tested again the next day. When npm
cannot be reached the job says so and tests the pinned release. Each job
reports that it skipped while its tenant's secrets are missing.

## Set up the Udibo tenant

Use a Udibo test tenant that holds synthetic users only. In the tenant's
dashboard:

1. **Application.** Create an application:
   - **Public** (no client secret), **first-party**, environment
     **Development**, so `http://localhost` is allowed.
   - Grant: **Authorization code** (add **Refresh token** for session renewal;
     the tests do not need it).
   - Redirect URI and post-logout redirect URI: exactly `http://localhost:3000`,
     with no trailing slash. The app sends its origin as both, and Udibo
     matches them exactly.
   - Access tokens: **JWT**, audience
     `https://migrate-from-auth0-react.example/api`.
2. **Test user.** A synthetic user who signs in with a username and password,
   with no second factor.
3. **No extra sign-in steps.** No second factor for the test user, and bot
   protection (CAPTCHA) off for the tenant: either stops an automated sign-in.
   Each run makes one wrong-password attempt, then signs in.
4. **A second audience, for the audience test.** A machine application with
   the **client credentials** grant and JWT access tokens for
   `https://other-api.example`. Its client ID and secret are the two optional
   secrets below.

Then add these **repository secrets**:

| Secret | Value |
| --- | --- |
| `UDIBO_ISSUER` | The tenant's issuer, as its discovery document names it, such as `https://<tenant id>.udibo.com` |
| `UDIBO_CLIENT_ID` | The application's client ID |
| `UDIBO_AUDIENCE` | `https://migrate-from-auth0-react.example/api` |
| `UDIBO_TEST_USERNAME` | The test user's username |
| `UDIBO_TEST_PASSWORD` | The test user's password |
| `UDIBO_OTHER_AUDIENCE_CLIENT_ID` | Optional: the machine application's client ID |
| `UDIBO_OTHER_AUDIENCE_CLIENT_SECRET` | Optional: its secret |

For a local run against the tenant, put the same names in `.env.local` and run
`E2E_PROVIDER=udibo npm run test:e2e`.

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
   on.
3. **The application's access to the API.** In the application's **APIs**
   tab, authorize it for this API with **user access**. Without it, Auth0
   sends the browser back to the app with an error instead of its login page:
   `Client "…" is not authorized to access resource server "…"`.
4. **Test user.** _User Management → Users → Create User_ in
   **Username-Password-Authentication**, with a synthetic email address and a
   password, and mark the email verified. Sign in as it once yourself to see
   that no extra step appears.
5. **No extra sign-in steps.** _Security → Multi-factor Auth_: **Never** (or
   no factor enabled). _Security → Attack Protection → Bot Detection_:
   **off**, since a CAPTCHA stops an automated sign-in. Leave brute-force protection on:
   each run makes one wrong-password attempt, then signs in.
6. **Login experience.** Universal Login, the default. The tests fill the
   username and password fields on one page, or on two when the tenant asks
   for the identifier first. They accept Auth0's consent page when it
   appears: Auth0 shows it for a `localhost` callback even when the API
   allows skipping consent.
7. **A second API, for the audience test.** _Applications → APIs → Create
   API_ with the _Identifier_ `https://other-api.example`, signing algorithm
   **RS256**. Then _Applications → Create Application_, type **Machine to
   Machine Applications**, and authorize it for `https://other-api.example`
   only (no scopes needed). Its Client ID and Client Secret are the two
   optional secrets below; without them the audience test skips and the rest
   run.

Then add these **repository secrets** (_Settings → Secrets and variables →
Actions_):

| Secret | Value |
| --- | --- |
| `AUTH0_DOMAIN` | The tenant's domain, such as `dev-abc123.us.auth0.com`, without `https://` |
| `AUTH0_CLIENT_ID` | The application's Client ID |
| `AUTH0_AUDIENCE` | The API's Identifier, `https://migrate-from-auth0-react.example/api` |
| `AUTH0_TEST_USERNAME` | The test user's email address |
| `AUTH0_TEST_PASSWORD` | The test user's password |
| `AUTH0_OTHER_AUDIENCE_CLIENT_ID` | Optional: the machine-to-machine application's Client ID |
| `AUTH0_OTHER_AUDIENCE_CLIENT_SECRET` | Optional: its Client Secret |

For a local run against the tenant, put the same names and values in
`.env.local`, which git ignores, and run `E2E_PROVIDER=auth0 npm run test:e2e`. The workflow passes the secrets only to the steps that check
for them and run the tests, and records no Playwright trace in CI, since a
trace includes what each step typed.

## Tested with

| Step | `@udibo/oauth2` | Node.js | Last live run |
| --- | --- | --- | --- |
| 0 | not used | 22, 24 (CI); 26 (locally) | 2026-11-06, [run 42172564187](https://github.com/udibo/migrate-from-auth0-react/actions/runs/42172564187): 6 of 6 passed |
| 1 | 0.51.0 | 22, 24 (CI); 26 (locally) | 2026-11-08, [run 42560839171](https://github.com/udibo/migrate-from-auth0-react/actions/runs/42560839171): 7 of 7 passed |
| 2 | 0.51.0 | 22, 24 (CI); 26 (locally) | 2026-11-10, [run 42954125573](https://github.com/udibo/migrate-from-auth0-react/actions/runs/42954125573): 7 of 7 passed against Udibo, 7 of 7 against Auth0 |

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
