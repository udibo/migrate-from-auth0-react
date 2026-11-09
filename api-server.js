require('dotenv').config({ path: '.env.local' })

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const { auth } = require("express-oauth2-jwt-bearer");

const app = express();

const port = process.env.API_PORT || 3001;
const appPort = process.env.SERVER_PORT || 3000;
const appOrigin = process.env.APP_BASE_URL || `http://localhost:${appPort}`;
const issuer = process.env.OAUTH_ISSUER;
const audience = process.env.OAUTH_AUDIENCE;

if (
  !issuer ||
  !audience ||
  audience === "{yourApiIdentifier}"
) {
  console.log(
    "Exiting API Server: Please make sure OAUTH_ISSUER and OAUTH_AUDIENCE environment variables are set"
  );

  process.exit();
}

app.use(morgan("dev"));
app.use(helmet());
app.use(cors({ origin: appOrigin }));

const checkJwt = auth({
  audience,
  issuerBaseURL: issuer,
  algorithms: ["RS256"],
});

app.get("/api/external", checkJwt, (req, res) => {
  res.send({
    msg: "Your access token was successfully validated!",
  });
});

app.listen(port, () => console.log(`API Server listening on port ${port}`));
