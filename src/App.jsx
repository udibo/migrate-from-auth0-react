import React from "react";
import { Routes, Route, useLocation, useNavigate } from "react-router-dom";
import Container from "react-bootstrap/Container";

import Loading from "./components/Loading";
import NavBar from "./components/NavBar";
import Footer from "./components/Footer";
import Home from "./views/Home";
import Profile from "./views/Profile";
import ExternalApi from "./views/ExternalApi";
import { OAuth2Callback, useOAuth2 } from "@udibo/oauth2/react";

// styles
import "./App.css";

// fontawesome
import initFontAwesome from "./utils/initFontAwesome";
initFontAwesome();

// The authorization server redirects back to the app's origin, as it did for
// Auth0's SDK, so the home route completes a sign-in when it carries the
// response.
const isAuthorizationResponse = (search) => {
  const params = new URLSearchParams(search);
  return params.has("state") && (params.has("code") || params.has("error"));
};

const SignInCallback = () => {
  const navigate = useNavigate();
  return (
    <OAuth2Callback
      onNavigate={(returnTo) => navigate(returnTo, { replace: true })}
      pending={<Loading />}
      fallback={(error) => <div>Oops... {error.message}</div>}
    />
  );
};

const App = () => {
  const { isLoading, error } = useOAuth2();
  const location = useLocation();

  if (location.pathname === "/" && isAuthorizationResponse(location.search)) {
    return <SignInCallback />;
  }

  if (error) {
    return <div>Oops... {error.message}</div>;
  }

  if (isLoading) {
    return <Loading />;
  }

  return (
    <div id="app" className="d-flex flex-column h-100">
      <NavBar />
      <Container className="flex-grow-1 mt-5">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/external-api" element={<ExternalApi />} />
        </Routes>
      </Container>
      <Footer />
    </div>
  );
};

export default App;
