import React from "react";
import { ExternalApiComponent } from "../ExternalApi";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useDirectClient, useOAuth2 } from "@udibo/oauth2/react";
import { getConfig } from "../../config";

jest.mock("../../config");
jest.mock("@udibo/oauth2/react", () => ({
  RequireAuth: ({ children }) => children,
  useDirectClient: jest.fn(),
  useOAuth2: jest.fn(),
}));

describe("The ExternalApi component", () => {
  beforeEach(() => {
    fetch.resetMocks();

    getConfig.mockReturnValue({
      domain: "test-domain.com",
      clientId: "123",
      apiOrigin: "http://localhost:3001",
      audience: "test-audience",
    });

    useOAuth2.mockReturnValue({
      isLoading: false,
      isAuthenticated: true,
      login: jest.fn(),
    });
    useDirectClient.mockReturnValue({
      getAccessToken: jest.fn(() => Promise.resolve("access-token")),
      login: jest.fn(),
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("renders", () => {
    render(<ExternalApiComponent />);
  });

  it("makes a call to the API when the button is clicked", async () => {
    fetch.mockResponseOnce(JSON.stringify({ msg: "This is the API result" }));

    render(<ExternalApiComponent />);
    fireEvent.click(screen.getByText("Ping API"));

    await waitFor(() => screen.getByTestId("api-result"));

    expect(
      await screen.findByText(/This is the API result/)
    ).toBeInTheDocument();
  });

  it("shows the warning content when there is no audience", async () => {
    getConfig.mockReturnValue(() => ({
      domain: "test-domain.com",
      clientId: "123",
      apiOrigin: "http://localhost:3001",
    }));

    render(<ExternalApiComponent />);

    expect(
      await screen.findByText(/You can't call the API at the moment/)
    ).toBeInTheDocument();
  });
});
