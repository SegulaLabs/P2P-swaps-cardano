"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { AssetInfoLite } from "@/lib/tokens";

/**
 * Client-side cache for asset display metadata (ticker/name/decimals).
 * Failures resolve to null — callers fall back to ASCII-name/short-id
 * rendering via tickerOf(). Cosmetic data only.
 */
const cache = new Map<string, AssetInfoLite | null>();
const inflight = new Map<string, Promise<AssetInfoLite | null>>();

export async function fetchAssetInfo(assetId: string): Promise<AssetInfoLite | null> {
  if (cache.has(assetId)) return cache.get(assetId)!;
  let pending = inflight.get(assetId);
  if (!pending) {
    pending = api
      .assetInfo(assetId)
      .catch(() => null)
      .then((info) => {
        cache.set(assetId, info);
        inflight.delete(assetId);
        return info;
      });
    inflight.set(assetId, pending);
  }
  return pending;
}

export function useAssetInfo(assetId: string | null): AssetInfoLite | null {
  const [info, setInfo] = useState<AssetInfoLite | null>(
    assetId ? (cache.get(assetId) ?? null) : null
  );

  useEffect(() => {
    let cancelled = false;
    if (!assetId) {
      setInfo(null);
      return;
    }
    fetchAssetInfo(assetId).then((i) => {
      if (!cancelled) setInfo(i);
    });
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  return info;
}
