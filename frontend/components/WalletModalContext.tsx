"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

/**
 * Lets any button (nav pill, trade panel CTA) open the same wallet-connect
 * drawer instead of each owning its own `open` state.
 */
const WalletModalContext = createContext<{
  open: boolean;
  show: () => void;
  hide: () => void;
} | null>(null);

export function WalletModalProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
  const value = useMemo(() => ({ open, show, hide }), [open, show, hide]);
  return <WalletModalContext.Provider value={value}>{children}</WalletModalContext.Provider>;
}

export function useWalletModal() {
  const ctx = useContext(WalletModalContext);
  if (!ctx) throw new Error("useWalletModal must be used within WalletModalProvider");
  return ctx;
}
