import { OrderBook } from "@/components/OrderBook";
import { TradePanel } from "@/components/TradePanel";
import { MarketsSidebar } from "@/components/MarketsSidebar";
import { PairTitle, PairInfo } from "@/components/PairTitle";
import { ScrollReset } from "@/components/ScrollReset";

/**
 * /trade/[pair] — the order book fills the left column from the top; a sticky
 * right rail holds the Market/Limit trade panel (always in view while you
 * scroll the book) with the markets list beneath it so you can switch books
 * in place. A title + token facts sit across the top.
 * pair = two asset ids sorted lexicographically, joined by "_"
 * (matches the undirected PairBeacon).
 */
export default async function TradePage({
  params,
}: {
  params: Promise<{ pair: string }>;
}) {
  const { pair } = await params;
  const [a, b] = pair.split("_") as [string, string];
  // Default to selling ADA when the pair has it (the common taker intent).
  const initialSellAsset = b === "lovelace" ? b : a;
  const initialBuyAsset = initialSellAsset === a ? b : a;
  return (
    <>
      <ScrollReset trigger={pair} />
      <header className="trade-header">
        <div className="page-title">
          <PairTitle pairId={pair} />
        </div>
        <PairInfo pairId={pair} />
      </header>
      <div className="trade-layout">
        <section className="trade-books" aria-label="Order book">
          <OrderBook pairId={pair} />
        </section>
        <aside className="trade-side">
          <TradePanel initialSellAsset={initialSellAsset} initialBuyAsset={initialBuyAsset} />
          <MarketsSidebar activePair={pair} />
        </aside>
      </div>
    </>
  );
}
