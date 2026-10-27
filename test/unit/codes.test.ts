import { describe, expect, it } from "vitest";
import { findCode, serviceName, signInLink } from "@/lib/codes";

// Codes, built in: which emails carry a sign-in code or magic link, and what it is.

describe("findCode", () => {
  it("reads a numeric code next to its words", () => {
    expect(findCode("Your verification code", "Your code is 482913. It expires soon.")).toEqual({ code: "482913", link: undefined });
    expect(findCode("Sign in to Acme", "Use 123 456 to sign in.")).toMatchObject({ code: "123456" });
    expect(findCode("Your verification code", "Your code is 482-913.")).toMatchObject({ code: "482913" });
  });

  it("offers the parts when it can't tell which one is the code", () => {
    const found = findCode("SARS eFiling OTP", "Dear Taxpayer, please make use of the following OTP for SARS eFiling:6246-160281");
    expect(found).toMatchObject({ choices: ["6246", "160281", "6246-160281"], shape: "4-6" });
    expect(found?.code).toBeUndefined();
  });

  it("reads a letters-and-digits code from the subject", () => {
    expect(findCode("QK7H2X is your Slack confirmation code", "Enter it in the app.")).toMatchObject({ code: "QK7H2X" });
  });

  it("ignores discount codes and ordinary mail", () => {
    expect(findCode("Your discount code inside", "Use code 20OFF for 20% off. Your code is 123456.")).toBeNull();
    expect(findCode("Lunch on Friday?", "Shall we meet at 12:30 at table 4421?")).toBeNull();
  });

  it("takes the one sign-in link in a short email", () => {
    const html = '<p>Click to sign in</p><a href="https://app.example.com/magic?token=abc">Sign in</a><a href="https://example.com/privacy">Privacy</a>';
    expect(findCode("Your magic link", "Click to sign in", html)).toEqual({ code: undefined, link: "https://app.example.com/magic?token=abc" });
    expect(signInLink('<a href="https://a.example/login">Log in</a><a href="https://b.example/verify">Verify</a>', "short")).toBeUndefined();
  });
});

describe("serviceName", () => {
  it("uses the sender's name, unless it's a placeholder like NOREPLY", () => {
    expect(serviceName({ name: "Slack", email: "no-reply@slack.com" })).toBe("Slack");
    expect(serviceName({ name: "NOREPLY", email: "noreply@sars.gov.za" })).toBe("sars.gov.za");
    expect(serviceName({ name: "Do Not Reply", email: "x@Bank.co.za" })).toBe("bank.co.za");
    expect(serviceName({ name: "", email: "codes@example.com" })).toBe("example.com");
  });
});
