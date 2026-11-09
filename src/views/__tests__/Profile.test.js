import React from "react";
import { render } from "@testing-library/react";
import { ProfileComponent } from "../Profile";
import { useOAuth2 } from "@udibo/oauth2/react";

jest.mock("@udibo/oauth2/react", () => ({
  RequireAuth: ({ children }) => children,
  useOAuth2: jest.fn(),
}));

describe("The profile component", () => {
  beforeEach(() => {
    useOAuth2.mockReturnValue({
      loading: false,
      user: {
        name: "Test user",
        email: "test@user.com",
        picture: "https://avatar.com",
      },
    });
  });

  it("renders when loading = true", () => {
    render(<ProfileComponent />);
  });
});
