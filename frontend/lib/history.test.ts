import { describe, expect, it } from "vitest";
import { summarizeFlow } from "./history";
import type { TxSummary } from "./types";

const base = { network: "preprod" as const, description: "", warnings: [] as string[] };

describe("summarizeFlow — net wallet effect per action", () => {
  it("create-order: locks the offered asset and the deposit (both out)", () => {
    const s: TxSummary = {
      ...base,
      action: "create-order",
      offered: { assetId: "lovelace", amount: "1000000000" },
      requested: { assetId: "aa.5445535441", amount: "1000" },
      depositLovelace: "5000000",
    };
    expect(summarizeFlow(s)).toEqual([
      { direction: "out", label: "Locked", assetId: "lovelace", amount: "1000000000" },
      { direction: "out", label: "Deposit", assetId: "lovelace", amount: "5000000" },
    ]);
  });

  it("take-order: pays the ask (out), receives the offer (in)", () => {
    const s: TxSummary = {
      ...base,
      action: "take-order",
      offered: { assetId: "aa.5445535441", amount: "50" },
      requested: { assetId: "lovelace", amount: "36000000" },
      depositLovelace: "5000000", // seller's deposit — not a taker flow line
    };
    expect(summarizeFlow(s)).toEqual([
      { direction: "in", label: "Received", assetId: "aa.5445535441", amount: "50" },
      { direction: "out", label: "Paid", assetId: "lovelace", amount: "36000000" },
    ]);
  });

  it("cancel-order: returns the offered asset and the deposit (both in)", () => {
    const s: TxSummary = {
      ...base,
      action: "cancel-order",
      offered: { assetId: "lovelace", amount: "1000000000" },
      depositLovelace: "5000000",
    };
    expect(summarizeFlow(s)).toEqual([
      { direction: "in", label: "Returned", assetId: "lovelace", amount: "1000000000" },
      { direction: "in", label: "Deposit", assetId: "lovelace", amount: "5000000" },
    ]);
  });

  it("mixed-asset take-many with no aggregates yields no lines (tx link carries detail)", () => {
    const s: TxSummary = { ...base, action: "take-many-orders" };
    expect(summarizeFlow(s)).toEqual([]);
  });
});
