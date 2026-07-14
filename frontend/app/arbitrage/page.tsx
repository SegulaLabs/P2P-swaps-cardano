import { ArbitragePanel } from "@/components/ArbitragePanel";

/** /arbitrage — riskless profit cycles over the open book, each settled as
 *  ONE atomic TakeManyOrders tx (docs/arbitrage.md). */
export default function ArbitragePage() {
  return (
    <>
      <div className="page-title">
        <h1>Arbitrage</h1>
      </div>
      <ArbitragePanel />
    </>
  );
}
