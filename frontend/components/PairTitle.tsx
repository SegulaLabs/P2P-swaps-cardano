"use client";

import { useAssetInfo } from "@/hooks/useAssetInfo";
import { decimalsOf, tickerOf } from "@/lib/tokens";
import { shortId } from "@/lib/validate";
import { TokenAvatar, TokenTicker } from "./Token";

export function PairTitle({ pairId }: { pairId: string }) {
  const [a, b] = pairId.split("_") as [string, string];
  return (
    <>
      <span className="pair-avatars">
        <TokenAvatar assetId={a} size={32} />
        <TokenAvatar assetId={b} size={32} />
      </span>
      <h1>
        <TokenTicker assetId={a} /> / <TokenTicker assetId={b} />
      </h1>
    </>
  );
}

/** A short factual line about each side of the pair (name / id / decimals),
 *  shown under the title. Metadata is cosmetic and may be absent — we still
 *  show the ticker and a truncated asset id in that case. */
export function PairInfo({ pairId }: { pairId: string }) {
  const [a, b] = pairId.split("_") as [string, string];
  return (
    <div className="pair-info muted small">
      <TokenFacts assetId={a} />
      <span aria-hidden className="pair-info-sep">
        ·
      </span>
      <TokenFacts assetId={b} />
    </div>
  );
}

function TokenFacts({ assetId }: { assetId: string }) {
  const info = useAssetInfo(assetId);
  const ticker = tickerOf(info, assetId);

  if (assetId === "lovelace") {
    return (
      <span className="pair-fact">
        <strong>{ticker}</strong> — Cardano preprod native currency
      </span>
    );
  }

  const name = info?.name && info.name !== ticker ? info.name : null;
  const decimals = info ? decimalsOf(info, assetId) : undefined;
  return (
    <span className="pair-fact">
      <strong>{ticker}</strong>
      {name ? ` — ${name}` : ""}{" "}
      <span className="mono">{shortId(assetId, 6)}</span>
      {decimals ? ` · ${decimals} decimals` : ""}
    </span>
  );
}
