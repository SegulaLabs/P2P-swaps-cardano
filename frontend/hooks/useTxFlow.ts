"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@meshsdk/react";
import { deserializeAddress } from "@meshsdk/core";
import type { TxSummary, UnsignedTxResponse, WalletContextPayload } from "@/lib/types";
import { ApiError } from "@/lib/api";
import { recordHistory } from "@/lib/history";
import {
  getChangeAddressBech32,
  getCollateralMesh,
  getUtxosMesh,
  pickCollateral,
  signAndSubmit,
} from "@/lib/walletAdapter";

/** Best-effort record of a just-submitted tx to the local activity log.
 *  Never throws — history is cosmetic and must not affect the tx result. */
async function logSubmitted(
  wallet: ReturnType<typeof useWallet>["wallet"],
  txHash: string,
  summary: TxSummary
): Promise<void> {
  let owner: string | null = null;
  try {
    const addr = await getChangeAddressBech32(wallet);
    owner = deserializeAddress(addr).stakeCredentialHash || null;
  } catch {
    /* keep owner null — entry still shows for the current wallet */
  }
  recordHistory({ txHash, timestamp: Date.now(), owner, summary });
}

/**
 * The build -> preview -> sign -> submit state machine shared by all three
 * flows. SAFETY: the unsigned tx is NEVER signed before the user explicitly
 * confirms the TransactionPreview; the browser wallet is the only signer.
 */

export type TxFlowState =
  | { step: "idle" }
  | { step: "building" }
  | { step: "preview"; tx: UnsignedTxResponse }
  | { step: "signing"; tx: UnsignedTxResponse }
  | { step: "submitted"; txHash: string }
  | { step: "error"; message: string };

export function useTxFlow() {
  const { wallet, connected } = useWallet();
  const [state, setState] = useState<TxFlowState>({ step: "idle" });

  // The preview / status view replaces the list in place — jump to the top so
  // the user sees it from the start instead of wherever they had scrolled to.
  useEffect(() => {
    if (state.step === "preview" || state.step === "submitted") {
      window.scrollTo({ top: 0 });
    }
  }, [state.step]);

  /** Snapshot the wallet context the backend needs for coin selection.
   *  Uses the walletAdapter normalizers (the beta wallet's raw CIP-30
   *  methods return hex, not bech32/Mesh shapes — see lib/walletAdapter.ts).
   *  pickCollateral guards against a wallet designating an oversized UTxO as
   *  collateral (confirmed live: one wallet reported its single largest
   *  UTxO — 99.6% of its balance — as collateral, which then got correctly
   *  but disastrously excluded from spending on every tx) by preferring a
   *  small pure-ADA UTxO from the wallet's own set when that happens. */
  const getWalletContext = useCallback(async (): Promise<WalletContextPayload> => {
    if (!connected || !wallet) throw new Error("connect a wallet first");
    const changeAddress = await getChangeAddressBech32(wallet);
    const utxos = await getUtxosMesh(wallet);
    if (utxos.length === 0)
      throw new Error("wallet has no UTxOs — fund it from the preprod faucet");
    const collateral = pickCollateral(await getCollateralMesh(wallet), utxos);
    if (!collateral)
      throw new Error(
        "no usable collateral: set collateral in your wallet, or keep one plain-ADA UTxO (>= 5 tADA, no tokens) in it"
      );
    return { changeAddress, utxos, collateral };
  }, [wallet, connected]);

  const build = useCallback(
    async (builder: (ctx: WalletContextPayload) => Promise<UnsignedTxResponse>) => {
      setState({ step: "building" });
      try {
        const ctx = await getWalletContext();
        const tx = await builder(ctx);
        setState({ step: "preview", tx });
      } catch (e) {
        setState({
          step: "error",
          message: e instanceof ApiError ? `${e.code}: ${e.message}` : String(e),
        });
      }
    },
    [getWalletContext]
  );

  /** Called only from the preview's explicit confirm button. */
  const confirmAndSign = useCallback(async () => {
    if (state.step !== "preview" || !wallet) return;
    setState({ step: "signing", tx: state.tx });
    try {
      // partialSign=true: the tx carries script witnesses the wallet doesn't
      // own; the wallet adds the user's key signatures only. signAndSubmit
      // uses signTxReturnFullTx (raw CIP-30 signTx returns only a witness
      // set — see lib/walletAdapter.ts).
      const txHash = await signAndSubmit(wallet, state.tx.unsignedTxCborHex);
      setState({ step: "submitted", txHash });
      // Fire-and-forget: append to the local history trail shown on /orders.
      void logSubmitted(wallet, txHash, state.tx.summary);
    } catch (e) {
      setState({ step: "error", message: String(e) });
    }
  }, [state, wallet]);

  const reject = useCallback(() => setState({ step: "idle" }), []);
  const reset = useCallback(() => setState({ step: "idle" }), []);

  return { state, build, confirmAndSign, reject, reset, connected };
}
