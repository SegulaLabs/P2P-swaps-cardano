"use client";

import { useState } from "react";
import { useWallet } from "@meshsdk/react";
import { useInstalledWallets } from "@/hooks/useInstalledWallets";
import { useOwnerCredential } from "@/hooks/useOwnerCredential";
import { useWalletModal } from "@/components/WalletModalContext";
import { KNOWN_WALLETS } from "@/lib/knownWallets";
import { shortId } from "@/lib/validate";
import { Portal } from "./Portal";

/**
 * Jupiter-style connect: a pill button that opens a right-side drawer listing
 * detected CIP-30 wallets (icon + name) plus common wallets not yet
 * installed (grayed out, with an install link). When connected, the button
 * shows the address; the drawer shows identity + disconnect.
 * The wallet remains the ONLY signer in the system (docs/security.md §1).
 */
export function WalletConnect() {
  const { connect, disconnect, connected, connecting, name } = useWallet();
  const { wallets, scanning, rescan } = useInstalledWallets();
  const { address, stakeCredential } = useOwnerCredential();
  const { open, show, hide } = useWalletModal();
  const [error, setError] = useState<string | null>(null);

  const notInstalled = KNOWN_WALLETS.filter(
    (k) => !wallets.some((w) => w.id === k.id)
  );

  async function pick(walletId: string) {
    setError(null);
    try {
      // connect() needs the window.cardano KEY (wallet.id), not the display
      // name — passing the display name silently fails to connect.
      // Second arg persists the choice to localStorage so refreshing the
      // page reconnects automatically instead of dropping back to "Connect".
      await connect(walletId, true);
      hide();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <button
        type="button"
        className={connected ? "btn btn-ghost wallet-pill" : "btn btn-primary"}
        onClick={() => {
          show();
          if (!connected) rescan();
        }}
      >
        {connected && address ? shortId(address, 8) : connecting ? "Connecting…" : "Connect"}
      </button>

      {open && (
        <Portal>
        <div className="drawer-overlay" onClick={() => hide()}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{connected ? "Wallet" : "Connect a wallet"}</h3>
              <button type="button" className="icon-btn" onClick={() => hide()} aria-label="Close">
                ✕
              </button>
            </div>

            {connected ? (
              <div className="wallet-details">
                <p className="muted small">Connected via {name}</p>
                <div className="kv">
                  <span>Address</span>
                  <code className="mono">{address ?? "…"}</code>
                </div>
                <div className="kv">
                  <span>Owner credential (staking key)</span>
                  {stakeCredential ? (
                    <code className="mono">{stakeCredential}</code>
                  ) : (
                    <span className="warn">
                      none — this wallet address has no staking part, and the
                      protocol identifies order owners by staking key. Use an
                      account with a base (staked) address.
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    disconnect();
                    hide();
                  }}
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <>
                <div className="wallet-section-head">
                  <p className="muted small">
                    Installed {wallets.length > 0 ? `(${wallets.length})` : ""}
                  </p>
                  <button type="button" className="linklike" onClick={rescan}>
                    {scanning ? "Scanning…" : "Rescan"}
                  </button>
                </div>
                <div className="wallet-list">
                  {wallets.length === 0 && !scanning && (
                    <p className="muted">
                      No CIP-30 wallet extensions detected in this browser.
                      Install one below, or refresh this page after installing.
                    </p>
                  )}
                  {wallets.length === 0 && scanning && (
                    <p className="muted">Looking for installed wallets…</p>
                  )}
                  {wallets.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      className="wallet-row"
                      onClick={() => void pick(w.id)}
                      disabled={connecting}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={w.icon} alt="" width={28} height={28} />
                      <span>{w.name}</span>
                    </button>
                  ))}
                </div>

                {notInstalled.length > 0 && (
                  <>
                    <p className="muted small wallet-section-head" style={{ marginTop: "1rem" }}>
                      Not installed
                    </p>
                    <div className="wallet-list">
                      {notInstalled.map((k) => (
                        <a
                          key={k.id}
                          href={k.installUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="wallet-row wallet-row-disabled"
                        >
                          <span className="wallet-row-fallback-icon">
                            {k.name.slice(0, 1)}
                          </span>
                          <span>{k.name}</span>
                          <span className="muted small" style={{ marginLeft: "auto" }}>
                            Install ↗
                          </span>
                        </a>
                      ))}
                    </div>
                  </>
                )}

                {error && <p className="warn">{error}</p>}
                <p className="muted small" style={{ marginTop: "1rem" }}>
                  Preprod only. Your wallet signs every transaction — this
                  site never sees your keys.
                </p>
              </>
            )}
          </aside>
        </div>
        </Portal>
      )}
    </>
  );
}
