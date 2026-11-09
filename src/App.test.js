import React from 'react';
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from './App';

jest.mock("@udibo/oauth2/react", () => ({
  OAuth2Callback: () => null,
  useOAuth2: () => ({ isLoading: false, isAuthenticated: false, error: null, user: null }),
}));

it('renders without crashing', () => {
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>
  );
});
