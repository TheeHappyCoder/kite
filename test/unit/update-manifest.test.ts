import { describe, expect, it } from "vitest";
import { updateManifest } from "../../scripts/update-manifest.mjs";

describe("signed update manifest", () => {
  const input = { version: "0.2.0", tag: "v0.2.0", filename: "Kite_0.2.0_x64-setup.exe", signature: "signed-payload\n", notes: "Fixes\n\n• Faster launch", date: "2026-10-27T12:00:00Z" };
  it("preserves notes and connects the platform to the signed release asset", () => {
    const result = updateManifest(input);
    expect(result.version).toBe("0.2.0");
    expect(result.notes).toBe(input.notes);
    expect(result.pub_date).toBe(input.date);
    expect(result.platforms["windows-x86_64"]).toEqual({ signature: "signed-payload", url: "https://github.com/TheeHappyCoder/kite/releases/download/v0.2.0/Kite_0.2.0_x64-setup.exe" });
  });
  it("refuses unsigned and non-installer assets", () => {
    expect(() => updateManifest({ ...input, signature: " " })).toThrow("Missing updater signature");
    expect(() => updateManifest({ ...input, filename: "kite.exe" })).toThrow("NSIS");
  });
});
