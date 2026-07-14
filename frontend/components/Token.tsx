"use client";

import { useAssetInfo } from "@/hooks/useAssetInfo";
import { avatarHue, decimalsOf, fromRawAmount, tickerOf } from "@/lib/tokens";

/**
 * Round token avatar. ADA (lovelace) shows the official Cardano logo; every
 * other asset gets a letter-avatar tinted with a stable per-asset colour so
 * different markets are easy to tell apart at a glance.
 */
export function TokenAvatar({ assetId, size = 28 }: { assetId: string; size?: number }) {
  const info = useAssetInfo(assetId);
  const ticker = tickerOf(info, assetId);

  if (assetId === "lovelace") {
    return (
      <img
        className="token-avatar"
        src="/tokens/cardano.png"
        width={size}
        height={size}
        alt=""
        aria-hidden
      />
    );
  }

  const hue = avatarHue(assetId);
  return (
    <span
      className="token-avatar"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `linear-gradient(135deg, hsl(${hue} 65% 42%), hsl(${(hue + 40) % 360} 65% 30%))`,
      }}
      aria-hidden
    >
      {ticker.slice(0, 2).toUpperCase()}
    </span>
  );
}

/** Ticker text resolved from metadata (registry > ASCII > short id). */
export function TokenTicker({ assetId }: { assetId: string }) {
  const info = useAssetInfo(assetId);
  return <>{tickerOf(info, assetId)}</>;
}

/** Human-formatted raw amount using the asset's (cosmetic) decimals. */
export function TokenAmount({ assetId, raw }: { assetId: string; raw: string | bigint }) {
  const info = useAssetInfo(assetId);
  return (
    <>
      {fromRawAmount(BigInt(raw), decimalsOf(info, assetId))}{" "}
      <TokenTicker assetId={assetId} />
    </>
  );
}
