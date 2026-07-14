import { describe, expect, it } from "vitest";
import type { Order } from "../types.js";
import { pairIdOf, planSmartFill, ratioToDecimal } from "./smart-fill.js";

/**
 * Pure route-selection tests. Orders are minimal fixtures — only the fields the
 * planner reads matter (assets, amounts, status, expiration).
 */

const TOKEN = `${"bb".repeat(28)}.544f4b42`; // policyId.name

/** Build an open order OFFERING `offer` for `request` (raw amounts as strings). */
function makeOrder(
  id: string,
  offer: { asset: string; amount: string },
  request: { asset: string; amount: string },
  extra: Partial<Order> = {}
): Order {
  const split = (a: string) =>
    a === "lovelace" ? { p: "", n: "" } : { p: a.split(".")[0]!, n: a.split(".")[1]! };
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

// User wants to SPEND lovelace to RECEIVE TOKEN. Matching orders OFFER TOKEN,
// REQUEST lovelace. Effective price = requested(lovelace) / offered(TOKEN).
const params = (maxSpend: bigint) =>
  ({
    spendAsset: "lovelace",
    receiveAsset: TOKEN,
    mode: "spend",
    limit: maxSpend,
  }) as const;

const receiveParams = (minReceive: bigint) =>
  ({
    spendAsset: "lovelace",
    receiveAsset: TOKEN,
    mode: "receive",
    limit: minReceive,
  }) as const;

describe("ratioToDecimal", () => {
  it("is bigint-safe and trims trailing zeros", () => {
    expect(ratioToDecimal(1n, 2n)).toBe("0.5");
    expect(ratioToDecimal(10n, 4n)).toBe("2.5");
    expect(ratioToDecimal(4n, 2n)).toBe("2");
    // beyond Number.MAX_SAFE_INTEGER — must not lose precision
    expect(ratioToDecimal(9_007_199_254_740_993n, 1n)).toBe("9007199254740993");
  });
  it("returns '' when the denominator is zero", () => {
    expect(ratioToDecimal(5n, 0n)).toBe("");
  });
});

describe("planSmartFill", () => {
  it("picks cheapest effective price first and never exceeds maxSpend", () => {
    const orders = [
      // price 12/1 = 12 (worst)
      makeOrder("a#0", { asset: TOKEN, amount: "100" }, { asset: "lovelace", amount: "1200" }),
      // price 10/1 = 10 (best)
      makeOrder("b#0", { asset: TOKEN, amount: "100" }, { asset: "lovelace", amount: "1000" }),
      // price 11/1 = 11 (middle)
      makeOrder("c#0", { asset: TOKEN, amount: "100" }, { asset: "lovelace", amount: "1100" }),
    ];
    const route = planSmartFill(orders, params(2200n));
    expect(route.legs.map((l) => l.orderId)).toEqual(["b#0", "c#0"]);
    expect(route.totalSpend).toBe("2100");
    expect(route.totalReceive).toBe("200");
    // v2: both legs fit one TakeManyOrders batch -> ONE atomic tx.
    expect(route.transactionCount).toBe(1);
    expect(route.atomic).toBe(true);
    expect(BigInt(route.totalSpend)).toBeLessThanOrEqual(2200n);
  });

  it("never partially fills: skips an order that doesn't fully fit the budget", () => {
    const orders = [
      makeOrder("b#0", { asset: TOKEN, amount: "100" }, { asset: "lovelace", amount: "1000" }),
      makeOrder("c#0", { asset: TOKEN, amount: "100" }, { asset: "lovelace", amount: "1100" }),
    ];
    // Budget fits b (1000) but not c (needs 1100 more -> only 500 left).
    const route = planSmartFill(orders, params(1500n));
    expect(route.legs.map((l) => l.orderId)).toEqual(["b#0"]);
    expect(route.totalSpend).toBe("1000");
    expect(route.warnings.some((w) => /unused/i.test(w))).toBe(true);
  });

  it("prefers a later cheaper order that still fits over an earlier pricier one", () => {
    const orders = [
      // price 11 but too big for the remaining budget after picking the cheap one
      makeOrder("big#0", { asset: TOKEN, amount: "100" }, { asset: "lovelace", amount: "1100" }),
      // price 9, small
      makeOrder("cheap#0", { asset: TOKEN, amount: "10" }, { asset: "lovelace", amount: "90" }),
    ];
    const route = planSmartFill(orders, params(1000n));
    // cheap#0 (90) first, then big#0 (1100) doesn't fit the 910 left.
    expect(route.legs.map((l) => l.orderId)).toEqual(["cheap#0"]);
  });

  it("only considers orders on the taker's side of the book", () => {
    const orders = [
      // wrong direction: offers lovelace, requests TOKEN
      makeOrder("wrong#0", { asset: "lovelace", amount: "1000" }, { asset: TOKEN, amount: "100" }),
      // right direction
      makeOrder("right#0", { asset: TOKEN, amount: "100" }, { asset: "lovelace", amount: "1000" }),
    ];
    const route = planSmartFill(orders, params(5000n));
    expect(route.legs.map((l) => l.orderId)).toEqual(["right#0"]);
  });

  it("ignores non-open orders", () => {
    const orders = [
      makeOrder("taken#0", { asset: TOKEN, amount: "100" }, { asset: "lovelace", amount: "500" }, { status: "taken" }),
      makeOrder("open#0", { asset: TOKEN, amount: "100" }, { asset: "lovelace", amount: "1000" }),
    ];
    const route = planSmartFill(orders, params(5000n));
    expect(route.legs.map((l) => l.orderId)).toEqual(["open#0"]);
  });

  it("ignores expired orders (unfillable — only the owner can claim them)", () => {
    const now = 1_800_000_000_000;
    const orders = [
      // Cheaper but expired a millisecond ago — must be skipped.
      makeOrder("expired#0", { asset: TOKEN, amount: "100" }, { asset: "lovelace", amount: "500" }, { expiration: now }),
      makeOrder("live#0", { asset: TOKEN, amount: "100" }, { asset: "lovelace", amount: "1000" }, { expiration: now + 1 }),
      makeOrder("never#0", { asset: TOKEN, amount: "100" }, { asset: "lovelace", amount: "2000" }),
    ];
    const route = planSmartFill(orders, { ...params(5000n), nowPosixMs: now });
    expect(route.legs.map((l) => l.orderId)).toEqual(["live#0", "never#0"]);
  });

  it("computes a bigint-safe average price", () => {
    const orders = [
      makeOrder("a#0", { asset: TOKEN, amount: "4" }, { asset: "lovelace", amount: "10" }),
      makeOrder("b#0", { asset: TOKEN, amount: "6" }, { asset: "lovelace", amount: "20" }),
    ];
    const route = planSmartFill(orders, params(100n));
    // total spend 30, total receive 10 -> 3
    expect(route.averagePrice).toBe("3");
  });

  it("warns and returns no legs when nothing matches the pair", () => {
    const route = planSmartFill([], params(1000n));
    expect(route.legs).toEqual([]);
    expect(route.transactionCount).toBe(0);
    expect(route.averagePrice).toBe("");
    expect(route.warnings.some((w) => /no open orders/i.test(w))).toBe(true);
  });

  it("warns when the budget is below the cheapest order (no partial fills)", () => {
    const orders = [
      makeOrder("a#0", { asset: TOKEN, amount: "100" }, { asset: "lovelace", amount: "1000" }),
    ];
    const route = planSmartFill(orders, params(500n));
    expect(route.legs).toEqual([]);
    expect(route.warnings.some((w) => /increase it to fill at least one/i.test(w))).toBe(true);
  });

  it("v2 batching: routes within the cap are ONE atomic tx", () => {
    const orders = [1, 2, 3].map((i) =>
      makeOrder(`o${i}#0`, { asset: TOKEN, amount: "10" }, { asset: "lovelace", amount: "100" })
    );
    const route = planSmartFill(orders, params(1000n));
    expect(route.legs).toHaveLength(3);
    expect(route.transactionCount).toBe(1);
    expect(route.atomic).toBe(true);
    expect(route.maxOrdersPerTx).toBe(8);
    expect(route.warnings.some((w) => /transactions/i.test(w))).toBe(false);
  });

  it("v2 batching: routes over the cap split into atomic batches with a warning", () => {
    const orders = [1, 2, 3].map((i) =>
      makeOrder(`o${i}#0`, { asset: TOKEN, amount: "10" }, { asset: "lovelace", amount: "100" })
    );
    const route = planSmartFill(orders, { ...params(1000n), maxOrdersPerTx: 2 });
    expect(route.legs).toHaveLength(3);
    expect(route.transactionCount).toBe(2); // ceil(3/2)
    expect(route.atomic).toBe(false);
    expect(route.warnings.some((w) => /needs 2 transactions/i.test(w))).toBe(true);
  });

  it("receive mode: fills cheapest orders until the target is met (whole orders overshoot)", () => {
    const orders = [
      // price 40, 10 TESTA
      makeOrder("a#0", { asset: TOKEN, amount: "10" }, { asset: "lovelace", amount: "400" }),
      // price 45, 15 TESTA
      makeOrder("b#0", { asset: TOKEN, amount: "15" }, { asset: "lovelace", amount: "675" }),
      // price 60, 10 TESTA (should not be needed)
      makeOrder("c#0", { asset: TOKEN, amount: "10" }, { asset: "lovelace", amount: "600" }),
    ];
    // want at least 20 TESTA -> a (10) then b (15) = 25 (overshoots), stop before c.
    const route = planSmartFill(orders, receiveParams(20n));
    expect(route.legs.map((l) => l.orderId)).toEqual(["a#0", "b#0"]);
    expect(route.totalReceive).toBe("25");
    expect(route.totalSpend).toBe("1075");
    expect(route.mode).toBe("receive");
    expect(route.warnings.some((w) => /doesn't allow partial fills/i.test(w))).toBe(true);
  });

  it("receive mode: stops as soon as an exact target is reached", () => {
    const orders = [
      makeOrder("a#0", { asset: TOKEN, amount: "10" }, { asset: "lovelace", amount: "400" }),
      makeOrder("b#0", { asset: TOKEN, amount: "15" }, { asset: "lovelace", amount: "675" }),
    ];
    const route = planSmartFill(orders, receiveParams(10n));
    expect(route.legs.map((l) => l.orderId)).toEqual(["a#0"]);
    expect(route.totalReceive).toBe("10");
  });

  it("receive mode: warns when the book can't reach the target", () => {
    const orders = [
      makeOrder("a#0", { asset: TOKEN, amount: "10" }, { asset: "lovelace", amount: "400" }),
    ];
    const route = planSmartFill(orders, receiveParams(50n));
    expect(route.totalReceive).toBe("10");
    expect(route.warnings.some((w) => /of your .* target is available/i.test(w))).toBe(true);
  });

  it("carries per-leg expiration through", () => {
    const orders = [
      makeOrder("a#0", { asset: TOKEN, amount: "100" }, { asset: "lovelace", amount: "1000" }, { expiration: 1893456000000 }),
    ];
    const route = planSmartFill(orders, params(5000n));
    expect(route.legs[0]!.expiration).toBe(1893456000000);
  });
});

describe("v3 partial legs", () => {
  it("spend mode: leftover budget becomes ONE partial leg on the cheapest partial-enabled order", () => {
    const orders = [
      makeOrder("whole#0", { asset: TOKEN, amount: "100" }, { asset: "lovelace", amount: "1000" }),
      makeOrder(
        "part#0",
        { asset: TOKEN, amount: "100" },
        { asset: "lovelace", amount: "1100" },
        { allowPartialFill: true }
      ),
    ];
    // 1500 budget: whole#0 (1000) fits; 500 leftover -> partial on part#0.
    const route = planSmartFill(orders, params(1500n));
    expect(route.legs.map((l) => l.orderId)).toEqual(["whole#0", "part#0"]);
    const partial = route.legs[1]!;
    expect(partial.partial).toBe(true);
    // maxTakeForSpend(500, 1100, 100) = floor(500*100/1100) = 45;
    // required = ceil(45*1100/100) = 495.
    expect(partial.takeAmount).toBe("45");
    expect(partial.spend).toBe("495");
    expect(partial.receive).toBe("45");
    expect(route.totalSpend).toBe("1495");
    expect(BigInt(route.totalSpend)).toBeLessThanOrEqual(1500n);
    expect(route.warnings.some((w) => /partial fill/i.test(w))).toBe(true);
  });

  it("spend mode: no partial leg when nothing is partial-enabled", () => {
    const orders = [
      makeOrder("whole#0", { asset: TOKEN, amount: "100" }, { asset: "lovelace", amount: "1000" }),
      makeOrder("other#0", { asset: TOKEN, amount: "100" }, { asset: "lovelace", amount: "1100" }),
    ];
    const route = planSmartFill(orders, params(1500n));
    expect(route.legs.map((l) => l.orderId)).toEqual(["whole#0"]);
    expect(route.warnings.some((w) => /don't allow partial fills/i.test(w))).toBe(true);
  });

  it("spend mode: dust threshold skips a tiny partial leg with a warning", () => {
    const orders = [
      makeOrder("whole#0", { asset: TOKEN, amount: "100" }, { asset: "lovelace", amount: "1000" }),
      makeOrder(
        "part#0",
        { asset: TOKEN, amount: "100" },
        { asset: "lovelace", amount: "1100" },
        { allowPartialFill: true }
      ),
    ];
    const route = planSmartFill(orders, {
      ...params(1500n),
      minPartialSpend: 1_000_000n,
    });
    expect(route.legs.map((l) => l.orderId)).toEqual(["whole#0"]);
    expect(route.warnings.some((w) => /dust threshold/i.test(w))).toBe(true);
  });

  it("receive mode: a partial-enabled last order hits the target EXACTLY", () => {
    const orders = [
      makeOrder("a#0", { asset: TOKEN, amount: "10" }, { asset: "lovelace", amount: "400" }),
      makeOrder(
        "b#0",
        { asset: TOKEN, amount: "15" },
        { asset: "lovelace", amount: "675" },
        { allowPartialFill: true }
      ),
    ];
    // target 20: a (10 whole) + b partial take 10 of 15 (required = 450).
    const route = planSmartFill(orders, receiveParams(20n));
    expect(route.legs.map((l) => l.orderId)).toEqual(["a#0", "b#0"]);
    expect(route.totalReceive).toBe("20");
    const partial = route.legs[1]!;
    expect(partial.partial).toBe(true);
    expect(partial.takeAmount).toBe("10");
    expect(partial.spend).toBe("450");
    expect(route.totalSpend).toBe("850");
  });

  it("smallest-fill edge: budget below required(1) leaves the leftover unused", () => {
    const orders = [
      makeOrder(
        "part#0",
        { asset: TOKEN, amount: "100" },
        { asset: "lovelace", amount: "1100" },
        { allowPartialFill: true }
      ),
    ];
    // required(1) = ceil(1100/100) = 11 > 10 -> no leg at all.
    const route = planSmartFill(orders, params(10n));
    expect(route.legs).toEqual([]);
  });
});

describe("pairIdOf", () => {
  it("is undirected (sorted)", () => {
    expect(pairIdOf("lovelace", TOKEN)).toBe(pairIdOf(TOKEN, "lovelace"));
  });
});
