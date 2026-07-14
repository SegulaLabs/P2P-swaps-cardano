// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(cleanup);
import { NetworkBadge } from "./NetworkBadge";
import { TransactionPreview } from "./TransactionPreview";
import type { UnsignedTxResponse } from "@/lib/types";

/**
 * Component tests for the safety-critical UI pieces. Components that need the
 * Mesh wallet context (OrderBook/MyOrders/CreateOrderForm) are exercised via
 * their pure logic (lib/validate.test.ts) and the preview below — the
 * wallet-flow wiring is verified manually against preprod.
 */

const WARNINGS = [
  "Experimental MVP on Cardano preprod — not audited. Never use mainnet funds.",
  "The backend is not trusted for security: verify this transaction in your wallet before signing.",
  "This summary is backend-provided; full client-side CBOR verification is not implemented yet.",
];

function takeTx(): UnsignedTxResponse {
  return {
    unsignedTxCborHex: "84a300",
    summary: {
      action: "take-order",
      network: "preprod",
      description: "Take order d1…#0",
      offered: { assetId: "lovelace", amount: "5000000" },
      requested: { assetId: `${"bb".repeat(28)}.544f4b42`, amount: "250" },
      depositLovelace: "3500000",
      beacons: { burned: ["a", "b", "c", "d", "e"] },
      paymentAddress: "addr_test1xyz",
      warnings: WARNINGS,
    },
  };
}

describe("NetworkBadge", () => {
  it("shows preprod by default", () => {
    render(<NetworkBadge />);
    expect(screen.getByText("preprod")).toBeTruthy();
  });

  it("screams on any non-preprod network", () => {
    const prev = process.env.NEXT_PUBLIC_CARDANO_NETWORK;
    process.env.NEXT_PUBLIC_CARDANO_NETWORK = "mainnet";
    try {
      render(<NetworkBadge />);
      expect(screen.getByText(/MISCONFIGURED: mainnet/)).toBeTruthy();
    } finally {
      process.env.NEXT_PUBLIC_CARDANO_NETWORK = prev;
    }
  });
});

describe("TransactionPreview", () => {
  it("shows the not-audited / backend-not-trusted warnings, unhidden", () => {
    render(
      <TransactionPreview tx={takeTx()} onConfirm={() => {}} onReject={() => {}} />
    );
    for (const w of WARNINGS) {
      expect(screen.getByText(`⚠ ${w}`)).toBeTruthy();
    }
  });

  it("take preview leads with the net effect and discloses the deposit", () => {
    const { container } = render(
      <TransactionPreview tx={takeTx()} onConfirm={() => {}} onReject={() => {}} />
    );
    // Wallet-style signed net effect.
    expect(container.textContent).toContain("You receive");
    expect(container.textContent).toContain("You pay");
    // Deposit disclosure kept (now in Details).
    expect(container.textContent).toContain("Seller deposit");
    expect(container.textContent).toContain("returned to the seller");
  });

  it("cancel preview shows beacon burn and deposit returned to you", () => {
    const tx = takeTx();
    tx.summary = {
      ...tx.summary,
      action: "cancel-order",
      description: "Cancel order",
    };
    const { container } = render(
      <TransactionPreview tx={tx} onConfirm={() => {}} onReject={() => {}} />
    );
    expect(container.textContent).toContain("burns 5 order tokens");
    expect(container.textContent).toContain("Deposit returned");
  });

  it("partial-fill preview flags the remainder and the min-ADA note", () => {
    const tx = takeTx();
    tx.summary = {
      ...tx.summary,
      action: "take-order-partial",
      offered: { assetId: `${"bb".repeat(28)}.544f4b42`, amount: "1" },
      requested: { assetId: "lovelace", amount: "16000000" },
      partialFills: [
        {
          orderId: `${"a1".repeat(32)}#0`,
          takeAmount: "1",
          paidAsk: "16000000",
          remainingOffer: "10",
          remainingAsk: "160000000",
          continuationAddress: "addr_test1zqt40",
        },
      ],
    };
    const { container } = render(
      <TransactionPreview tx={tx} onConfirm={() => {}} onReject={() => {}} />
    );
    expect(container.textContent).toContain("Partial");
    expect(container.textContent).toContain("stays on the book as a new order");
    expect(container.textContent).toContain("min-ADA");
  });

  it("requires explicit confirmation before signing", () => {
    const onConfirm = vi.fn();
    render(
      <TransactionPreview tx={takeTx()} onConfirm={onConfirm} onReject={() => {}} />
    );
    expect(onConfirm).not.toHaveBeenCalled(); // rendering must never auto-sign
    fireEvent.click(screen.getByText("Continue to wallet"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
