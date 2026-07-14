"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { PairId } from "@/lib/types";
import { TradePanel } from "@/components/TradePanel";
import { TokenAvatar, TokenTicker } from "@/components/Token";
import { Callout } from "@/components/Callout";

/**
 * Home = the swap-style order form front and center (Jupiter-style), with
 * live markets underneath. Placing an order is the primary action; taking
 * existing orders happens on the pair pages below.
 */
export default function HomePage() {
  const [pairs, setPairs] = useState<PairId[]>([]);
  const [apiOk, setApiOk] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .pairs()
      .then((r) => {
        setPairs(r.pairs);
        setApiOk(true);
      })
      .catch(() => setApiOk(false));
  }, []);

  return (
    <>
      <div className="hero">
        <h1>Trade peer-to-peer on Cardano</h1>
        <p>
          Place a fixed-price order from your wallet — it settles on-chain
          when someone takes it. No pools, no custody, and orders can be
          filled partially at your price.
        </p>
      </div>

      {apiOk === false && (
        <div style={{ maxWidth: 480, margin: "0 auto" }}>
          <Callout label="OFFLINE" tone="warn">
            Backend unreachable — start it with <code>npm run backend:dev</code>.
          </Callout>
        </div>
      )}

      <TradePanel />

      <section style={{ marginTop: "2.2rem" }}>
        <div className="page-title">
          <h1>Markets with open orders</h1>
        </div>
        {pairs.length === 0 ? (
          <p className="muted">
            None yet — the order you place above opens the first market.
          </p>
        ) : (
          <div className="market-grid">
            {pairs.map((p) => {
              const [a, b] = p.split("_") as [string, string];
              return (
                <Link key={p} href={`/trade/${encodeURIComponent(p)}`} className="market-card">
                  <span className="pair-avatars">
                    <TokenAvatar assetId={a} size={30} />
                    <TokenAvatar assetId={b} size={30} />
                  </span>
                  <strong>
                    <TokenTicker assetId={a} /> / <TokenTicker assetId={b} />
                  </strong>
                  <span className="muted" style={{ marginLeft: "auto" }}>
                    View book →
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
