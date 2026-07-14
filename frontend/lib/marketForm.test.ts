import { describe, expect, it } from "vitest";
import { flipMarketSides } from "./marketForm";

/**
 * Regression: flipping the Market tab's sides used to clear BOTH typed
 * amounts. The fix keeps whichever number the user actually typed, now
 * attached to the (swapped) box they were editing, and clears only the
 * computed side so it re-quotes for the new direction.
 */
describe("flipMarketSides", () => {
  it("swaps the assets", () => {
    const r = flipMarketSides({
      spendAsset: "TESTF",
      receiveAsset: "lovelace",
      spendHuman: "50",
      receiveHuman: "100",
      edited: "spend",
    });
    expect(r.spendAsset).toBe("lovelace");
    expect(r.receiveAsset).toBe("TESTF");
  });

  it("keeps the typed amount when the user was editing the SPEND box, clears the computed receive side", () => {
    const r = flipMarketSides({
      spendAsset: "TESTF",
      receiveAsset: "lovelace",
      spendHuman: "50", // user typed this
      receiveHuman: "100", // computed estimate
      edited: "spend",
    });
    expect(r.spendHuman).toBe("50"); // preserved — now against the new spend asset
    expect(r.receiveHuman).toBe(""); // cleared — recomputed by the quote effect
  });

  it("keeps the typed amount when the user was editing the RECEIVE box, clears the computed spend side", () => {
    const r = flipMarketSides({
      spendAsset: "TESTF",
      receiveAsset: "lovelace",
      spendHuman: "50", // computed estimate
      receiveHuman: "100", // user typed this
      edited: "receive",
    });
    expect(r.receiveHuman).toBe("100");
    expect(r.spendHuman).toBe("");
  });

  it("handles null assets (nothing picked yet) without throwing", () => {
    const r = flipMarketSides({
      spendAsset: null,
      receiveAsset: "lovelace",
      spendHuman: "",
      receiveHuman: "",
      edited: "spend",
    });
    expect(r.spendAsset).toBe("lovelace");
    expect(r.receiveAsset).toBeNull();
  });
});
