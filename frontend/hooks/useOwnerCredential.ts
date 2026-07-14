"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@meshsdk/react";
import { deserializeAddress } from "@meshsdk/core";
import { getChangeAddressBech32 } from "@/lib/walletAdapter";

/**
 * The connected wallet's staking key hash — the protocol's owner identity
 * (names the OwnerBeacon, keys /orders/by-owner).
 */
export function useOwnerCredential(): {
  address: string | null;
  stakeCredential: string | null;
} {
  const { wallet, connected } = useWallet();
  const [address, setAddress] = useState<string | null>(null);
  const [stakeCredential, setStakeCredential] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!connected || !wallet) {
      setAddress(null);
      setStakeCredential(null);
      return;
    }
    (async () => {
      // Normalized to bech32 — the beta wallet's raw getChangeAddress()
      // returns hex CBOR bytes (lib/walletAdapter.ts), which broke both the
      // display and the staking-credential detection for real wallets.
      const addr = await getChangeAddressBech32(wallet);
      if (cancelled) return;
      setAddress(addr);
      try {
        const parsed = deserializeAddress(addr);
        setStakeCredential(parsed.stakeCredentialHash || null);
      } catch {
        setStakeCredential(null);
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [wallet, connected]);

  return { address, stakeCredential };
}
