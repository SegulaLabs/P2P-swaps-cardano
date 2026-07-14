"use client";

import { useEffect } from "react";

/**
 * Forces the window back to the top whenever `trigger` changes. Needed because
 * navigating between two `/trade/[pair]` pages stays on the same route segment,
 * so the App Router keeps the previous scroll position — you'd land mid-page
 * on the new market. Keyed on the pair id, this snaps to the top on each switch.
 */
export function ScrollReset({ trigger }: { trigger: string }) {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [trigger]);
  return null;
}
