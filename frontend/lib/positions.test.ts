import { describe, expect, it } from "vitest";
import { fillEvents, groupPositions, positionStatus } from "./positions";
import type { Order } from "./types";

function order(p: Partial<Order> & { orderId: string }): Order {
  return {
    txHash: p.orderId.split("#")[0]!,
    outputIndex: Number(p.orderId.split("#")[1] ?? 0),
    status: "open",
    pairId: "A_B",
    contractAddress: "addr_test1contract",
    ownerStakeCredential: "stake",
    paymentAddress: "addr_test1pay",
    offeredPolicyId: "aa",
    offeredAssetName: "544f4b",
    offeredAmount: "100",
    requestedPolicyId: "",
    requestedAssetName: "",
    requestedAmount: "100",
    depositLovelace: "3500000",
    version: 1,
    ...p,
  };
}

describe("groupPositions", () => {
  it("keeps a plain order as a length-1 chain (renders like before)", () => {
    const os = [order({ orderId: "plain#0" })];
    const [p] = groupPositions(os);
    expect(p!.chain).toHaveLength(1);
    expect(p!.original.orderId).toBe("plain#0");
    expect(p!.tip.orderId).toBe("plain#0");
    expect(positionStatus(p!)).toMatchObject({ label: "open", canCancel: true });
  });

  it("collapses a partial-fill chain into one position, root→tip", () => {
    // root sold 100→60, continuation open with 60 remaining.
    const root = order({
      orderId: "root#0",
      status: "partially_filled",
      offeredAmount: "100",
      requestedAmount: "100",
      rootOrderId: "root#0",
    });
    const tip = order({
      orderId: "cont#1",
      status: "open",
      offeredAmount: "60",
      requestedAmount: "60",
      parentOrderId: "root#0",
      rootOrderId: "root#0",
    });
    // Backend returns most-recent first.
    const [p] = groupPositions([tip, root]);
    expect(p!.chain.map((o) => o.orderId)).toEqual(["root#0", "cont#1"]);
    expect(p!.original.offeredAmount).toBe("100");
    expect(p!.tip.offeredAmount).toBe("60");

    const st = positionStatus(p!);
    expect(st).toMatchObject({ label: "partially filled", tone: "partial", canCancel: true });
    expect(st.filledFraction).toBeCloseTo(0.4);

    const fills = fillEvents(p!);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ soldOffered: 40n, receivedAsk: 40n, txHash: "cont", kind: "fill" });
  });

  it("marks a fully-drained chain as filled with a final event", () => {
    // Two partial fills then a final full take of the last continuation.
    const root = order({ orderId: "r#0", status: "partially_filled", offeredAmount: "100", requestedAmount: "100", rootOrderId: "r#0" });
    const mid = order({ orderId: "c#1", status: "partially_filled", offeredAmount: "60", requestedAmount: "60", parentOrderId: "r#0", rootOrderId: "r#0" });
    const tip = order({ orderId: "c#2", status: "taken", offeredAmount: "20", requestedAmount: "20", parentOrderId: "c#1", rootOrderId: "r#0" });
    const [p] = groupPositions([tip, mid, root]);
    expect(p!.chain.map((o) => o.orderId)).toEqual(["r#0", "c#1", "c#2"]);
    const st = positionStatus(p!);
    expect(st).toMatchObject({ label: "filled", tone: "done", canCancel: false });
    expect(st.filledFraction).toBe(1);
    const fills = fillEvents(p!);
    expect(fills.map((f) => f.kind)).toEqual(["fill", "fill", "final"]);
    expect(fills[0]!.soldOffered).toBe(40n);
    expect(fills[1]!.soldOffered).toBe(40n);
    expect(fills[2]!.soldOffered).toBe(20n);
  });

  it("keeps two unrelated positions separate", () => {
    const a = order({ orderId: "a#0" });
    const b = order({ orderId: "b#0" });
    expect(groupPositions([a, b])).toHaveLength(2);
  });
});

describe("expired positions", () => {
  const NOW = 1_800_000_000_000;

  it("an open order past its expiration reads as expired + claimable", () => {
    const [p] = groupPositions([order({ orderId: "e#0", expiration: NOW - 1 })]);
    const st = positionStatus(p!, NOW);
    expect(st).toMatchObject({
      label: "expired",
      tone: "expired",
      canCancel: true,
      expired: true,
    });
  });

  it("an open order expiring in the future stays open", () => {
    const [p] = groupPositions([order({ orderId: "f#0", expiration: NOW + 60_000 })]);
    expect(positionStatus(p!, NOW)).toMatchObject({ label: "open", expired: false });
  });

  it("a partially-filled chain whose tip expired reads as expired, keeping fill %", () => {
    const root = order({ orderId: "r#0", status: "partially_filled", offeredAmount: "100", requestedAmount: "100", rootOrderId: "r#0", expiration: NOW - 1 });
    const tip = order({ orderId: "c#1", status: "open", offeredAmount: "60", requestedAmount: "60", parentOrderId: "r#0", rootOrderId: "r#0", expiration: NOW - 1 });
    const [p] = groupPositions([tip, root]);
    const st = positionStatus(p!, NOW);
    expect(st).toMatchObject({ label: "expired", expired: true, canCancel: true });
    expect(st.filledFraction).toBeCloseTo(0.4);
  });

  it("terminal statuses are never marked expired", () => {
    const [p] = groupPositions([
      order({ orderId: "t#0", status: "taken", expiration: NOW - 1 }),
    ]);
    expect(positionStatus(p!, NOW)).toMatchObject({ label: "filled", expired: false });
  });
});
