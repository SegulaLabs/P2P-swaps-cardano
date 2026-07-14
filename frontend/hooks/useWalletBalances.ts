"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@meshsdk/react";
import { getUtxosMesh } from "@/lib/walletAdapter";

export interface WalletBalance {
  assetId: string; // "lovelace" | "policy.nameHex"
  raw: bigint;
}

/** Aggregated wallet balances from the wallet's UTxO set. */
export function useWalletBalances(): {
  balances: WalletBalance[];
  refresh: () => void;
} {
  const { wallet, connected } = useWallet();
  const [balances, setBalances] = useState<WalletBalance[]>([]);

  const refresh = useCallback(() => {
    if (!connected || !wallet) {
      setBalances([]);
      return;
    }
    getUtxosMesh(wallet)
      .then((utxos) => {
        const sums = new Map<string, bigint>();
        for (const u of utxos) {
          for (const a of u.output.amount) {
            const id =
              a.unit === "lovelace" || a.unit === ""
                ? "lovelace"
                : `${a.unit.slice(0, 56)}.${a.unit.slice(56)}`;
            sums.set(id, (sums.get(id) ?? 0n) + BigInt(a.quantity));
          }
        }
        setBalances(
          [...sums.entries()]
            .map(([assetId, raw]) => ({ assetId, raw }))
            .sort((a, b) =>
              a.assetId === "lovelace" ? -1 : b.assetId === "lovelace" ? 1 : a.assetId < b.assetId ? -1 : 1
            )
        );
      })
      .catch(() => setBalances([]));
  }, [wallet, connected]);

  useEffect(refresh, [refresh]);

  return { balances, refresh };
}
