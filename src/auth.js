import { DirectClient } from "@udibo/oauth2/client";

/**
 * A DirectClient that asks for `audience` on every sign-in, as Auth0 needs to
 * issue a JWT access token for the API. DirectClient has no option for a
 * default authorize parameter, and RequireAuth and useOAuth2().login pass only
 * `returnTo`, so the parameter is added here (udibo/oauth2#189).
 */
class AudienceClient extends DirectClient {
  #audience;

  constructor({ audience, ...options }) {
    super(options);
    this.#audience = audience;
  }

  login(options = {}) {
    const extraParams = this.#audience ? { audience: this.#audience, ...options.extraParams } : options.extraParams;
    return super.login({ ...options, extraParams });
  }
}

/**
 * The app's OAuth2 client: a public client (no secret) in the browser, with
 * PKCE, pending sign-ins in sessionStorage and tokens in memory.
 */
export function createClient({ issuer, clientId, audience }) {
  return new AudienceClient({
    issuer,
    clientId,
    audience,
    redirectUri: window.location.origin,
    scope: "openid profile email",
  });
}
