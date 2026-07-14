"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Renders children into document.body, bypassing ancestor stacking contexts.
 *
 * LIVE BUG this fixes: WalletConnect's drawer and TokenSelect's modal were
 * rendered inline inside the component tree. `.site-header` uses
 * `position: sticky` + a set `z-index`, which establishes its own stacking
 * context — any `position: fixed` overlay nested inside it (the drawer) gets
 * painted within THAT context rather than at the document root, so `<main>`
 * (a later DOM sibling of the header) could paint over it despite the
 * overlay's higher z-index number. Portalling to `document.body` sidesteps
 * ancestor stacking contexts entirely — the standard fix for this class of
 * bug in React, rather than chasing z-index/stacking-context values.
 */
export function Portal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}
