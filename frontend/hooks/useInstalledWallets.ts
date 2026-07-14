"use client";

import { useEffect, useState } from "react";

export interface DetectedWallet {
  /** window.cardano injection key — pass THIS to connect(), not `name`. */
  id: string;
  name: string;
  icon: string;
}

/**
 * Detects CIP-30 wallets from window.cardano directly (same filter Mesh's
 * BrowserWallet.getInstalledWallets uses: name+icon+apiVersion present).
 *
 * LIVE FINDING: @meshsdk/react's useWalletList() scans window.cardano
 * exactly once in a mount-time effect with no retry. Extensions frequently
 * inject a beat after the page's first render, so that one-shot scan can
 * permanently miss an installed wallet — the drawer showed nothing even
 * with Brave Wallet/Eternl installed. This hook polls for a few seconds
 * after mount (and once more on window focus, e.g. after installing an
 * extension and returning to the tab) instead of checking only once.
 */
export function useInstalledWallets(): {
  wallets: DetectedWallet[];
  scanning: boolean;
  rescan: () => void;
} {
  const [wallets, setWallets] = useState<DetectedWallet[]>([]);
  const [scanning, setScanning] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setScanning(true);

    function scanOnce(): DetectedWallet[] {
      const cardano = (window as unknown as { cardano?: Record<string, unknown> })
        .cardano;
      if (!cardano) return [];
      const found: DetectedWallet[] = [];
      for (const key of Object.keys(cardano)) {
        const w = cardano[key] as
          | { name?: string; icon?: string; apiVersion?: string }
          | undefined;
        if (!w || !w.name || !w.icon || w.apiVersion === undefined) continue;
        found.push({ id: key, name: w.name, icon: w.icon });
      }
      return found;
    }

    // Retry for a few seconds: extensions can inject after first paint.
    const attempts = [0, 200, 500, 900, 1500, 2500, 4000];
    const timers = attempts.map((delay) =>
      setTimeout(() => {
        if (cancelled) return;
        const found = scanOnce();
        if (found.length > 0) setWallets(found);
        if (delay === attempts[attempts.length - 1]) setScanning(false);
      }, delay)
    );

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [nonce]);

  // Re-scan when the user comes back to the tab (e.g. after installing).
  useEffect(() => {
    const onFocus = () => setNonce((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  return { wallets, scanning, rescan: () => setNonce((n) => n + 1) };
}
