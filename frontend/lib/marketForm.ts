/**
 * Pure form-state logic for the Market tab (components/TradePanel.tsx),
 * split out so it's testable without pulling in @meshsdk/react (importing
 * the component file drags in the wallet SDK, which needs a real browser
 * environment to initialize its crypto bindings).
 */

/**
 * Market tab's flip (⇅) button: swap the two assets but KEEP the number the
 * user actually typed — it stays attached to whichever box they were
 * editing (now showing the other asset), and the other, computed side
 * clears so it re-quotes for the new direction. Previously this cleared
 * both amounts entirely, discarding what the user had typed.
 */
export function flipMarketSides(state: {
  spendAsset: string | null;
  receiveAsset: string | null;
  spendHuman: string;
  receiveHuman: string;
  edited: "spend" | "receive";
}): {
  spendAsset: string | null;
  receiveAsset: string | null;
  spendHuman: string;
  receiveHuman: string;
} {
  return {
    spendAsset: state.receiveAsset,
    receiveAsset: state.spendAsset,
    spendHuman: state.edited === "spend" ? state.spendHuman : "",
    receiveHuman: state.edited === "receive" ? state.receiveHuman : "",
  };
}
