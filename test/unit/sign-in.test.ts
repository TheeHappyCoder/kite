import { describe, expect, it } from "vitest";
import { SignInError } from "@/server/mail/errors";
import { gmailRefusal } from "@/server/providers/imap/auth";

// Gmail's IMAP and SMTP wording for a refused sign-in, to the step of the walkthrough that fixes it.

describe("gmailRefusal", () => {
  it.each([
    // Gmail's IMAP answer to a normal password, and SMTP's.
    ["[ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)", "app_password", /normal Google password/],
    ["534-5.7.9 Application-specific password required. Learn more at", "app_password", /normal Google password/],
    // A wrong, revoked or stale app password.
    ["[AUTHENTICATIONFAILED] Invalid credentials (Failure)", "app_password", /didn't accept that app password/],
    ["535-5.7.8 Username and Password not accepted.", "app_password", /didn't accept that app password/],
    // IMAP turned off.
    ["[ALERT] Your account is not enabled for IMAP use. Please visit your Gmail settings page and enable your account for IMAP access. (Failure)", "imap", /Turn it on in Gmail's settings/],
    // Sign in on the web first.
    ["[ALERT] Please log in via your web browser: https://support.google.com/mail/accounts/answer/78754 (Failure)", "browser", /sign in once in your browser/],
    ["[WEBALERT https://accounts.google.com/signin/continue?sarp=1] Web login required.", "browser", /sign in once in your browser/],
    ["534-5.7.14 <https://accounts.google.com/signin/continue> Please log in", "browser", /sign in once in your browser/],
  ])("%s", (text, ask, message) => {
    const error = gmailRefusal(text, "someone@gmail.com");
    expect(error).toBeInstanceOf(SignInError);
    expect(error.ask).toBe(ask);
    expect(error.message).toMatch(message);
  });

  it("names the Workspace admin for work addresses", () => {
    expect(gmailRefusal("Your account is not enabled for IMAP use.", "thandi@company.co.za").message).toMatch(/Workspace admin/);
    expect(gmailRefusal("Invalid credentials", "thandi@company.co.za").message).toMatch(/your admin has turned them off/);
    expect(gmailRefusal("Invalid credentials", "someone@googlemail.com").message).toMatch(/2-Step Verification is turned off/);
  });

  it("falls back to the app password step for anything else", () => {
    expect(gmailRefusal("", "someone@gmail.com").ask).toBe("app_password");
  });
});
