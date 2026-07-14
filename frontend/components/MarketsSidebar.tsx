"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { PairId } from "@/lib/types";
import { TokenAvatar, TokenTicker } from "./Token";

/**
 * Markets list rendered alongside the order book on a pair page, so the user
 * can jump between books without going back home. The active pair is
 * highlighted. Pairs come from the same /pairs endpoint the home page uses.
 */
export function MarketsSidebar({ activePair }: { activePair: string }) {
  const [pairs, setPairs] = useState<PairId[]>([]);

  useEffect(() => {
    api
      .pairs()
      .then((r) => setPairs(r.pairs))
      .catch(() => setPairs([]));
  }, []);

  return (
    <aside className="markets-side">
      <h2 className="markets-side-title">Markets</h2>
      {pairs.length === 0 ? (
        <p className="muted small">No open markets yet.</p>
      ) : (
        <nav className="markets-side-list">
          {pairs.map((p) => {
            const [x, y] = p.split("_") as [string, string];
            const active = p === activePair;
            return (
              <Link
                key={p}
                href={`/trade/${encodeURIComponent(p)}`}
                className={`market-row${active ? " market-row-active" : ""}`}
                aria-current={active ? "page" : undefined}
              >
                <span className="pair-avatars">
                  <TokenAvatar assetId={x} size={22} />
                  <TokenAvatar assetId={y} size={22} />
                </span>
                <strong>
                  <TokenTicker assetId={x} /> / <TokenTicker assetId={y} />
                </strong>
              </Link>
            );
          })}
        </nav>
      )}
    </aside>
  );
}
