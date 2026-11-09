import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { OAuth2Provider } from "@udibo/oauth2/react";
import { BrowserRouter } from "react-router-dom";
import { getConfig } from "./config";
import { createClient } from "./auth";
import 'bootstrap/dist/css/bootstrap.min.css';

const client = createClient(getConfig());

const root = createRoot(document.getElementById('root'));
root.render(
  <BrowserRouter>
    <OAuth2Provider client={client}>
      <App />
    </OAuth2Provider>
  </BrowserRouter>,
);
