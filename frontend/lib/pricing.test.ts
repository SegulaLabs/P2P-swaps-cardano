import { describe, expect, it } from "vitest";
import { clampTake, maxTakeForSpend, requiredPayment } from "./pricing";

/**
 * Mirror tests for the v3 partial-fill math — MUST agree with
 * backend/src/protocol/datum.ts and order_rules.required_payment
 * (docs/partial-fills.md §1).
 */

describe("requiredPayment", () => {
  it("is ceil(take * ask / offer)", () => {
    expect(requiredPayment(40n, 250n, 100n)).toBe(100n);
    expect(requiredPayment(1n, 250n, 100n)).toBe(3n); // ceil(2.5)
    expect(requiredPayment(1n, 1n, 1_000_000n)).toBe(1n); // never 0
  });
  it("throws on non-positive input", () => {
    expect(() => requiredPayment(0n, 250n, 100n)).toThrow();
  });
});

describe("maxTakeForSpend", () => {
  it("inverts the ceil within all validity caps", () => {
    expect(maxTakeForSpend(10n, 250n, 100n)).toBe(4n);
    expect(maxTakeForSpend(2n, 250n, 100n)).toBe(0n);
    const take = maxTakeForSpend(10_000n, 250n, 100n);
    expect(take).toBe(99n); // capped at offer - 1
    expect(requiredPayment(take, 250n, 100n)).toBeLessThan(250n);
  });
});

describe("clampTake", () => {
  it("clamps into [1, max valid take]", () => {
    expect(clampTake(0n, 250n, 100n)).toBe(1n);
    expect(clampTake(50n, 250n, 100n)).toBe(50n);
    expect(clampTake(1_000n, 250n, 100n)).toBe(99n);
  });
  it("returns 0 when no partial take can be valid", () => {
    expect(clampTake(1n, 1n, 100n)).toBe(0n); // ask 1: required(any) == ask
    expect(clampTake(1n, 250n, 1n)).toBe(0n); // offer 1: nothing to split
  });
});
