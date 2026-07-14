import { describe, expect, it } from "vitest";
import {
  avatarHue,
  decimalsOf,
  fromRawAmount,
  hexToAsciiName,
  tickerOf,
  toRawAmount,
} from "./tokens";

const TESTA_ID = `${"05".repeat(28)}.5445535441`;

describe("token display helpers", () => {
  it("decodes printable hex names, rejects the rest", () => {
    expect(hexToAsciiName("5445535441")).toBe("TESTA");
    expect(hexToAsciiName("")).toBeNull();
    expect(hexToAsciiName("00ff")).toBeNull();
  });

  it("tickerOf prefers registry data, falls back to ASCII, never shows raw hex garbage silently", () => {
    expect(tickerOf(null, "lovelace")).toBe("tADA");
    expect(tickerOf(null, TESTA_ID)).toBe("TESTA");
    expect(
      tickerOf({ assetId: TESTA_ID, policyId: "", assetNameHex: "", ticker: "TST" }, TESTA_ID)
    ).toBe("TST");
    // non-printable name -> shortened id, clearly truncated
    expect(tickerOf(null, `${"05".repeat(28)}.00ff`)).toContain("…");
  });

  it("decimalsOf defaults: 6 for lovelace, 0 for unknown tokens", () => {
    expect(decimalsOf(null, "lovelace")).toBe(6);
    expect(decimalsOf(null, TESTA_ID)).toBe(0);
  });
});

describe("amount conversion (UI boundary only)", () => {
  it("round-trips human <-> raw", () => {
    expect(toRawAmount("1.5", 6)).toBe(1_500_000n);
    expect(toRawAmount("5", 6)).toBe(5_000_000n);
    expect(toRawAmount("100", 0)).toBe(100n);
    expect(fromRawAmount(1_500_000n, 6)).toBe("1.5");
    expect(fromRawAmount(5_000_000n, 6)).toBe("5");
    expect(fromRawAmount("94556710", 6)).toBe("94.55671");
    expect(fromRawAmount(100n, 0)).toBe("100");
  });

  it("rejects malformed or over-precise input", () => {
    expect(() => toRawAmount("1.2345678", 6)).toThrow(/decimal/);
    expect(() => toRawAmount("1.5", 0)).toThrow();
    expect(() => toRawAmount("-3", 6)).toThrow();
    expect(() => toRawAmount("abc", 6)).toThrow();
    expect(() => toRawAmount("", 6)).toThrow();
  });

  it("avatar hue is stable and bounded", () => {
    expect(avatarHue(TESTA_ID)).toBe(avatarHue(TESTA_ID));
    expect(avatarHue("lovelace")).toBeGreaterThanOrEqual(0);
    expect(avatarHue("lovelace")).toBeLessThan(360);
  });
});
