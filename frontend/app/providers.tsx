"use client";

import { useEffect } from "react";
import { MeshProvider, useWallet } from "@meshsdk/react";
import "@meshsdk/react/styles.css";
import { WalletModalProvider } from "@/components/WalletModalContext";

/**
 * Mesh keeps the last-connected wallet name in localStorage and will
 * reconnect on load, but only once persistence is switched on — it defaults
 * to off. This has no UI; it just flips that switch on mount.
 */
function WalletPersistence() {
  const { setPersist } = useWallet();
  useEffect(() => setPersist(true), [setPersist]);
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <MeshProvider>
      <WalletPersistence />
      <WalletModalProvider>{children}</WalletModalProvider>
    </MeshProvider>
  );
}
