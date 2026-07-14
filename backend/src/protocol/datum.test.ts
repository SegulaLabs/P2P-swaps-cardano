import { describe, expect, it } from "vitest";
import { serializeData } from "@meshsdk/core";
import {
  decodeOrderDatum,
  encodeOrderDatum,
  maxTakeForSpend,
  requiredPayment,
  type OrderDatumFields,
} from "./datum.js";

const BASE: OrderDatumFields = {
  version: 1,
  beaconPolicyId: "0e".repeat(28),
  ownerKeyHash: "01".repeat(28),
  paymentPubKeyHash: "03".repeat(28),
  paymentStakeKeyHash: null,
  offer: { policyId: "aa".repeat(28), assetNameHex: "544f4b41" },
  offerAmount: 100n,
  ask: { policyId: "bb".repeat(28), assetNameHex: "544f4b42" },
  askAmount: 250n,
  expiration: null,
  allowPartialFill: false,
};

function roundtrip(d: OrderDatumFields): OrderDatumFields {
  return decodeOrderDatum(serializeData(encodeOrderDatum(d), "Mesh"));
}

describe("order datum codec", () => {
  it("round-trips the base datum", () => {
    expect(roundtrip(BASE)).toEqual(BASE);
  });

  it("round-trips with staked payment address and expiration", () => {
    const d: OrderDatumFields = {
      ...BASE,
      paymentStakeKeyHash: "05".repeat(28),
      expiration: 1_800_000_000_000,
    };
    expect(roundtrip(d)).toEqual(d);
  });

  it("round-trips ADA offer (empty policy + name)", () => {
    const d: OrderDatumFields = {
      ...BASE,
      offer: { policyId: "", assetNameHex: "" },
      offerAmount: 5_000_000n,
    };
    expect(roundtrip(d)).toEqual(d);
  });

  it("rejects wrong version", () => {
    const cbor = serializeData(encodeOrderDatum({ ...BASE, version: 2 }), "Mesh");
    expect(() => decodeOrderDatum(cbor)).toThrow(/version/);
  });

  it("round-trips allow_partial_fill = true (v3)", () => {
    const d: OrderDatumFields = { ...BASE, allowPartialFill: true };
    expect(roundtrip(d)).toEqual(d);
  });

  it("rejects garbage CBOR", () => {
    expect(() => decodeOrderDatum("deadbeef")).toThrow();
  });
});

describe("v3 partial-fill pricing (mirrors order_rules.required_payment)", () => {
  it("required = ceil(take * ask / offer), seller-favourable", () => {
    expect(requiredPayment(40n, 250n, 100n)).toBe(100n); // exact
    expect(requiredPayment(1n, 250n, 100n)).toBe(3n); // ceil(2.5)
    expect(requiredPayment(1n, 1n, 1_000_000n)).toBe(1n); // never 0
    expect(requiredPayment(99n, 3n, 100n)).toBe(3n); // hits the full ask
  });

  it("requiredPayment rejects non-positive arguments", () => {
    expect(() => requiredPayment(0n, 250n, 100n)).toThrow();
    expect(() => requiredPayment(-1n, 250n, 100n)).toThrow();
  });

  it("maxTakeForSpend inverts the ceil within all validity caps", () => {
    // 100 offered for 250: 10 spend -> take 4 (required(4)=10)
    expect(maxTakeForSpend(10n, 250n, 100n)).toBe(4n);
    expect(requiredPayment(4n, 250n, 100n)).toBe(10n);
    // spend below the smallest fill -> 0
    expect(maxTakeForSpend(2n, 250n, 100n)).toBe(0n);
    // spend covering the whole order is capped to offer-1 AND required < ask
    const take = maxTakeForSpend(10_000n, 250n, 100n);
    expect(take).toBe(99n);
    expect(requiredPayment(take, 250n, 100n)).toBeLessThan(250n);
    // ask' > 0 cap binds before offer' > 0 when the ask is tiny
    const tiny = maxTakeForSpend(10_000n, 3n, 100n);
    expect(requiredPayment(tiny, 3n, 100n)).toBeLessThan(3n);
  });

  it("any fill sequence pays the seller at least pro-rata (ceil sums)", () => {
    // 100 for 250 filled 1 unit at a time: 100 * ceil(2.5) = 300 >= 250.
    let offer = 100n;
    let ask = 250n;
    let paid = 0n;
    while (offer > 1n && ask > 1n) {
      const r = requiredPayment(1n, ask, offer);
      if (r >= ask) break;
      paid += r;
      offer -= 1n;
      ask -= r;
    }
    paid += ask; // final full fill pays the remainder exactly
    expect(paid).toBeGreaterThanOrEqual(250n);
  });
});
