"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

/** Distinct assets that appear in pairs with open orders (+ tADA always). */
export function useMarketAssets(): string[] {
  const [assets, setAssets] = useState<string[]>(["lovelace"]);

  useEffect(() => {
    let cancelled = false;
    api
      .pairs()
      .then((r) => {
        if (cancelled) return;
        const ids = new Set<string>(["lovelace"]);
        for (const pair of r.pairs) for (const id of pair.split("_")) ids.add(id);
        setAssets([...ids]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return assets;
}
