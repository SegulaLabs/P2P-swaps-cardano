import { MyOrders } from "@/components/MyOrders";
import { TxHistory } from "@/components/TxHistory";

/** /orders — the connected wallet's open orders, plus a local activity log. */
export default function OrdersPage() {
  return (
    <>
      <div className="page-title">
        <h1>My orders</h1>
      </div>
      <MyOrders />
      <TxHistory />
    </>
  );
}
