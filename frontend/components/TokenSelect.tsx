"use client";

import { useMemo, useState } from "react";
import { useAssetInfo } from "@/hooks/useAssetInfo";
import { decimalsOf, fromRawAmount, tickerOf } from "@/lib/tokens";
import { TokenAvatar, TokenTicker } from "./Token";
import { Portal } from "./Portal";

export interface TokenOption {
  assetId: string;
  /** Raw balance to display next to the row (wallet-side lists). */
  balanceRaw?: bigint;
}

/**
 * Jupiter-style token picker: a pill button that opens a modal with search,
 * the provided token list (wallet tokens with balances, or market tokens),
 * and a paste-an-asset-id escape hatch for anything not listed.
 */
export function TokenSelect({
  value,
  options,
  onChange,
  label,
}: {
  value: string | null;
  options: TokenOption[];
  onChange: (assetId: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.assetId.toLowerCase().includes(q));
  }, [options, query]);

  function pick(assetId: string) {
    onChange(assetId);
    setOpen(false);
    setQuery("");
    setCustom("");
    setCustomError(null);
  }

  function pickCustom() {
    const id = custom.trim().toLowerCase();
    if (!/^(lovelace|[0-9a-f]{56}\.[0-9a-f]{0,64})$/.test(id)) {
      setCustomError("expected `lovelace` or policyIdHex.assetNameHex");
      return;
    }
    pick(id);
  }

  return (
    <>
      <button type="button" className="token-btn" onClick={() => setOpen(true)}>
        {value ? (
          <>
            <TokenAvatar assetId={value} size={24} />
            <span className="token-btn-label">
              <TokenTicker assetId={value} />
            </span>
          </>
        ) : (
          <span className="token-btn-label">Select token</span>
        )}
        <span className="chevron">▾</span>
      </button>

      {open && (
        <Portal>
        <div className="modal-overlay" onClick={() => setOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{label}</h3>
              <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
                ✕
              </button>
            </div>
            <input
              autoFocus
              className="modal-search"
              placeholder="Search by asset id…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="token-list">
              {filtered.length === 0 && (
                <p className="muted">No matching tokens{options.length === 0 ? " — none available yet" : ""}.</p>
              )}
              {filtered.map((o) => (
                <TokenRow key={o.assetId} option={o} onPick={pick} />
              ))}
            </div>
            <div className="modal-foot">
              <p className="muted">Not listed? Paste an asset id:</p>
              <div className="row">
                <input
                  value={custom}
                  placeholder="policyIdHex.assetNameHex"
                  onChange={(e) => {
                    setCustom(e.target.value);
                    setCustomError(null);
                  }}
                />
                <button type="button" className="btn btn-ghost" onClick={pickCustom}>
                  Use
                </button>
              </div>
              {customError && <p className="warn">{customError}</p>}
            </div>
          </div>
        </div>
        </Portal>
      )}
    </>
  );
}

function TokenRow({ option, onPick }: { option: TokenOption; onPick: (id: string) => void }) {
  const info = useAssetInfo(option.assetId);
  const ticker = tickerOf(info, option.assetId);
  const name = info?.name && info.name !== ticker ? info.name : option.assetId === "lovelace" ? "Preprod ADA" : "";
  return (
    <button type="button" className="token-row" onClick={() => onPick(option.assetId)}>
      <TokenAvatar assetId={option.assetId} size={34} />
      <span className="token-row-names">
        <strong>{ticker}</strong>
        {name && <small>{name}</small>}
      </span>
      {option.balanceRaw !== undefined && (
        <span className="token-row-balance">
          {fromRawAmount(option.balanceRaw, decimalsOf(info, option.assetId))}
        </span>
      )}
    </button>
  );
}
