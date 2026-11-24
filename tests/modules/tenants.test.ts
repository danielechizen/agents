import { describe, expect, test } from "bun:test";
import { sanitizeBranding } from "@/lib/branding";

// Branding sanitizer. Tenant create, rename and delete live in tenants.admin.service.

describe("sanitizeBranding (server-side)", () => {
  test("keeps allowlisted keys with valid color tokens", () => {
    expect(
      sanitizeBranding({
        accent: "#ff0000",
        accentSolid: "oklch(0.6 0.2 20)",
      }),
    ).toEqual({ accent: "#ff0000", accentSolid: "oklch(0.6 0.2 20)" });
  });

  test("drops unknown keys and invalid values (anti-injection)", () => {
    expect(
      sanitizeBranding({
        accent: "url(evil)",
        bgPrimary: "#000000",
        accentSoft: "#0f0",
      }),
    ).toEqual({ accentSoft: "#0f0" });
  });
});
