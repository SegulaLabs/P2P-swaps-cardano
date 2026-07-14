import { describe, expect, it } from "vitest";
import {
  assembleAssetId,
  validateCreateOrder,
  type CreateOrderInput,
} from "./validate";

const VALID: CreateOrderInput = {
  offerAsset: "lovelace",
  offerAmount: "5000000",
  askAsset: `${"bb".repeat(28)}.544f4b42`,
  askAmount: "250",
};

describe("create-order validation", () => {
  it("accepts a valid order", () => {
    const r = validateCreateOrder(VALID);
    expect("value" in r).toBe(true);
  });

  it.each([
    ["0", "zero"],
    ["-5", "negative"],
    ["1.5", "fractional"],
    ["abc", "non-numeric"],
    ["", "empty"],
  ])("rejects offered amount %s (%s)", (amount) => {
    const r = validateCreateOrder({ ...VALID, offerAmount: amount });
    expect("errors" in r && r.errors.some((e) => /offered amount/.test(e))).toBe(
      true
    );
  });

  it("rejects zero requested amount", () => {
    const r = validateCreateOrder({ ...VALID, askAmount: "0" });
    expect("errors" in r).toBe(true);
  });

  it("rejects offer == ask", () => {
    const r = validateCreateOrder({ ...VALID, askAsset: "lovelace" });
    expect("errors" in r && r.errors.some((e) => /differ/.test(e))).toBe(true);
  });

  it("rejects malformed asset ids", () => {
    const r = validateCreateOrder({ ...VALID, askAsset: "not-hex.zz" });
    expect("errors" in r).toBe(true);
  });

  it("rejects past expirations", () => {
    const r = validateCreateOrder({
      ...VALID,
      expiration: "2020-01-01T00:00",
    });
    expect("errors" in r && r.errors.some((e) => /future/.test(e))).toBe(true);
  });

  it("converts future expirations to ms", () => {
    const r = validateCreateOrder({ ...VALID, expiration: "2030-01-01T00:00" });
    expect("value" in r && typeof r.value.expiration === "number").toBe(true);
  });
});

describe("assembleAssetId", () => {
  it("maps empty inputs to lovelace", () => {
    expect(assembleAssetId("", "")).toBe("lovelace");
    expect(assembleAssetId("  ", " ")).toBe("lovelace");
  });
  it("joins policy and name with a dot, lowercased", () => {
    expect(assembleAssetId("AA".repeat(28), "544F4B41")).toBe(
      `${"aa".repeat(28)}.544f4b41`
    );
  });
});
