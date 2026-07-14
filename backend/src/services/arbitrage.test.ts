import { describe, expect, it } from "vitest";
import type { Order } from "../types.js";
import { pairIdOf } from "./smart-fill.js";
import { findArbitrage } from "./arbitrage.js";

/**
 * Pure cycle-finding tests (docs/arbitrage.md). Orders are minimal fixtures —
 * only the fields the finder reads matter (assets, amounts, status,
 * expiration, allowPartialFill).
 */

const TOKB = `${"bb".repeat(28)}.544f4b42`; // TOKB
const TOKC = `${"cc".repeat(28)}.544f4b43`; // TOKC

/** Build an open order OFFERING `offer` for `request` (raw amounts as strings). */
function makeOrder(
  id: string,
  offer: { asset: string; amount: string },
  request: { asset: string; amount: string },
  extra: Partial<Order> = {}
): Order {
  const split = (a: string) =>
    a === "lovelace"
      ? { p: "", n: "" }
      : { p: a.split(".")[0]!, n: a.split(".")[1]! };
  const o = split(offer.asset);
  const r = split(request.asset);
  return {
    orderId: id,
    txHash: id.split("#")[0]!,
    outputIndex: Number(id.split("#")[1] ?? 0),
    status: "open",
    pairId: pairIdOf(offer.asset, request.asset),
    contractAddress: "addr_test1_order",
    ownerStakeCredential: "aa".repeat(28),
    paymentAddress: "addr_test1_pay",
    offeredPolicyId: o.p,
    offeredAssetName: o.n,
    offeredAmount: offer.amount,
    requestedPolicyId: r.p,
    requestedAssetName: r.n,
    requestedAmount: request.amount,
    depositLovelace: "3500000",
    pairBeacon: "pb",
    offerBeacon: "ofb",
    askBeacon: "akb",
    ownerBeacon: "owb",
    version: 1,
    allowPartialFill: false,
    ...extra,
  };
}

describe("findArbitrage — direct (2-leg) cycles", () => {
  it("finds a crossed book where full fills chain exactly", () => {
    // o1: pay 100 ADA -> get 100 TOKB; o2: pay 100 TOKB -> get 120 ADA.
    const o1 = makeOrder("aa#0", { asset: TOKB, amount: "100" }, { asset: "lovelace", amount: "100" });
    const o2 = makeOrder("bb#0", { asset: "lovelace", amount: "120" }, { asset: TOKB, amount: "100" });
    const scan = findArbitrage([o1, o2], { feeEstimateLovelace: 5n });
    expect(scan.opportunities).toHaveLength(1);
    const opp = scan.opportunities[0]!;
    expect(opp.kind).toBe("direct");
    expect(opp.legs).toHaveLength(2);
    expect(opp.legs.every((l) => !l.partial)).toBe(true);
    // Net: +20 lovelace, 0 TOKB (filtered out of `net`).
    expect(opp.net).toEqual([{ assetId: "lovelace", amount: "20" }]);
    expect(opp.lovelaceNetAfterCosts).toBe("15"); // 20 − 5 fee
    expect(opp.marginPct).toBe("20"); // 120/100 × 100/100 − 1 = 20%
  });

  it("returns nothing when prices do not cross", () => {
    const o1 = makeOrder("aa#0", { asset: TOKB, amount: "100" }, { asset: "lovelace", amount: "100" });
    const o2 = makeOrder("bb#0", { asset: "lovelace", amount: "90" }, { asset: TOKB, amount: "100" });
    const scan = findArbitrage([o1, o2]);
    expect(scan.opportunities).toHaveLength(0);
    expect(scan.warnings.length).toBeGreaterThan(0);
  });

  it("trims the over-asking leg with a partial fill when allowed", () => {
    // o1 delivers only 50 TOKB; o2 asks 100 TOKB but allows partial fills.
    const o1 = makeOrder("aa#0", { asset: TOKB, amount: "50" }, { asset: "lovelace", amount: "50" });
    const o2 = makeOrder(
      "bb#0",
      { asset: "lovelace", amount: "120" },
      { asset: TOKB, amount: "100" },
      { allowPartialFill: true }
    );
    const scan = findArbitrage([o1, o2], { feeEstimateLovelace: 5n });
    expect(scan.opportunities).toHaveLength(1);
    const opp = scan.opportunities[0]!;
    const partial = opp.legs.find((l) => l.partial)!;
    expect(partial.orderId).toBe("bb#0");
    // maxTakeForSpend(50, 100, 120) = 60; required = ceil(60*100/120) = 50.
    expect(partial.takeAmount).toBe("60");
    expect(partial.payAmount).toBe("50");
    // Net: pay 50 ADA, receive 60 ADA -> +10 lovelace; TOKB nets 0.
    expect(opp.net).toEqual([{ assetId: "lovelace", amount: "10" }]);
    // Partial leg pays TOKB (a token) -> taker funds 1.4 ADA min-ADA.
    expect(opp.partialMinAdaLovelace).toBe("1400000");
    expect(opp.lovelaceNetAfterCosts).toBe((10n - 5n - 1_400_000n).toString());
  });

  it("rejects a shortfall when the order forbids partial fills", () => {
    const o1 = makeOrder("aa#0", { asset: TOKB, amount: "50" }, { asset: "lovelace", amount: "50" });
    const o2 = makeOrder("bb#0", { asset: "lovelace", amount: "120" }, { asset: TOKB, amount: "100" });
    // Rate product crosses (50/50 × 120/100 > 1) but amounts cannot chain in
    // either rotation without a wallet top-up.
    expect(findArbitrage([o1, o2]).opportunities).toHaveLength(0);
  });

  it("keeps surplus in the intermediate asset as token profit", () => {
    // o1 delivers 100 TOKB, o2 only needs 80 of them and pays 90 ADA vs 85.
    const o1 = makeOrder("aa#0", { asset: TOKB, amount: "100" }, { asset: "lovelace", amount: "85" });
    const o2 = makeOrder("bb#0", { asset: "lovelace", amount: "90" }, { asset: TOKB, amount: "80" });
    const scan = findArbitrage([o1, o2]);
    expect(scan.opportunities).toHaveLength(1);
    const nets = Object.fromEntries(
      scan.opportunities[0]!.net.map((n) => [n.assetId, n.amount])
    );
    expect(nets).toEqual({ lovelace: "5", [TOKB]: "20" });
  });

  it("skips expired and non-open orders", () => {
    const now = 1_800_000_000_000;
    const o1 = makeOrder(
      "aa#0",
      { asset: TOKB, amount: "100" },
      { asset: "lovelace", amount: "100" },
      { expiration: now - 1 }
    );
    const o2 = makeOrder("bb#0", { asset: "lovelace", amount: "120" }, { asset: TOKB, amount: "100" });
    const o3 = makeOrder(
      "cc#0",
      { asset: TOKB, amount: "100" },
      { asset: "lovelace", amount: "100" },
      { status: "taken" }
    );
    const scan = findArbitrage([o1, o2, o3], { nowPosixMs: now });
    expect(scan.opportunities).toHaveLength(0);
    expect(scan.scannedOrders).toBe(1);
  });
});

describe("findArbitrage — triangular (3-leg) cycles", () => {
  it("finds a profitable triangle across three pairs", () => {
    // ADA -100-> TOKB -100-> TOKC -110-> ADA
    const o1 = makeOrder("aa#0", { asset: TOKB, amount: "100" }, { asset: "lovelace", amount: "100" });
    const o2 = makeOrder("bb#0", { asset: TOKC, amount: "100" }, { asset: TOKB, amount: "100" });
    const o3 = makeOrder("cc#0", { asset: "lovelace", amount: "110" }, { asset: TOKC, amount: "100" });
    const scan = findArbitrage([o1, o2, o3], { feeEstimateLovelace: 5n });
    expect(scan.opportunities).toHaveLength(1);
    const opp = scan.opportunities[0]!;
    expect(opp.kind).toBe("triangular");
    expect(opp.legs).toHaveLength(3);
    expect(opp.net).toEqual([{ assetId: "lovelace", amount: "10" }]);
    expect(opp.marginPct).toBe("10");
  });

  it("chains partial trims forward around the triangle", () => {
    // o1 delivers 50 TOKB; o2 (partial ok) asks 100 TOKB -> trimmed to spend
    // 50, delivering 50 TOKC; o3 (partial ok) asks 100 TOKC -> trimmed to
    // spend 50, delivering 60 ADA vs the 40 ADA paid for o1.
    const o1 = makeOrder("aa#0", { asset: TOKB, amount: "50" }, { asset: "lovelace", amount: "40" });
    const o2 = makeOrder(
      "bb#0",
      { asset: TOKC, amount: "100" },
      { asset: TOKB, amount: "100" },
      { allowPartialFill: true }
    );
    const o3 = makeOrder(
      "cc#0",
      { asset: "lovelace", amount: "120" },
      { asset: TOKC, amount: "100" },
      { allowPartialFill: true }
    );
    const scan = findArbitrage([o1, o2, o3], { feeEstimateLovelace: 5n });
    expect(scan.opportunities).toHaveLength(1);
    const opp = scan.opportunities[0]!;
    expect(opp.legs.filter((l) => l.partial)).toHaveLength(2);
    expect(opp.net).toEqual([{ assetId: "lovelace", amount: "20" }]);
  });

  it("does not invent a cycle when one edge is missing", () => {
    const o1 = makeOrder("aa#0", { asset: TOKB, amount: "100" }, { asset: "lovelace", amount: "100" });
    const o2 = makeOrder("bb#0", { asset: TOKC, amount: "100" }, { asset: TOKB, amount: "100" });
    expect(findArbitrage([o1, o2]).opportunities).toHaveLength(0);
  });
});

describe("findArbitrage — ranking and identity", () => {
  it("ranks by quoted margin, best first, and dedupes by order set", () => {
    const a1 = makeOrder("aa#0", { asset: TOKB, amount: "100" }, { asset: "lovelace", amount: "100" });
    const a2 = makeOrder("bb#0", { asset: "lovelace", amount: "150" }, { asset: TOKB, amount: "100" });
    const b1 = makeOrder("cc#0", { asset: TOKC, amount: "100" }, { asset: "lovelace", amount: "100" });
    const b2 = makeOrder("dd#0", { asset: "lovelace", amount: "110" }, { asset: TOKC, amount: "100" });
    const scan = findArbitrage([a1, a2, b1, b2]);
    expect(scan.opportunities.map((o) => o.marginPct)).toEqual(["50", "10"]);
    const ids = scan.opportunities.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("legs carry what buildTakeManyOrders needs (orderId + optional takeAmount)", () => {
    const o1 = makeOrder("aa#0", { asset: TOKB, amount: "100" }, { asset: "lovelace", amount: "100" });
    const o2 = makeOrder("bb#0", { asset: "lovelace", amount: "120" }, { asset: TOKB, amount: "100" });
    const opp = findArbitrage([o1, o2]).opportunities[0]!;
    for (const leg of opp.legs) {
      expect(typeof leg.orderId).toBe("string");
      if (leg.partial) expect(BigInt(leg.takeAmount!)).toBeGreaterThan(0n);
      else expect(leg.takeAmount).toBeUndefined();
    }
  });
});
