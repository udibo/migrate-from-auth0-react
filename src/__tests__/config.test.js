describe("The config module", () => {
  beforeEach(() => {
    process.env.OAUTH_ISSUER = "https://test-domain.auth0.com/";
    process.env.OAUTH_CLIENT_ID = "123";
  });

  afterEach(() => {
    delete process.env.OAUTH_ISSUER;
    delete process.env.OAUTH_CLIENT_ID;
    delete process.env.OAUTH_AUDIENCE;
    jest.resetModules();
  });

  it("should omit the audience if not set", () => {
    const { getConfig } = require("../config");

    expect(getConfig().audience).not.toBeDefined();
  });

  it("should omit the audience if left at a default value", () => {
    process.env.OAUTH_AUDIENCE = "{yourApiIdentifier}";

    const { getConfig } = require("../config");

    expect(getConfig().audience).not.toBeDefined();
  });

  it("should return the audience if specified", () => {
    process.env.OAUTH_AUDIENCE = "test-api";

    const { getConfig } = require("../config");

    expect(getConfig().audience).toEqual("test-api");
  });
});
