// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TxStatus } from "./TxStatus";
import { api } from "@/lib/api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const TX_HASH = "ab".repeat(32);

describe("TxStatus", () => {
  it("auto-fires onSettled once confirmations reach the threshold, and never renders a dismiss button by default", async () => {
    vi.spyOn(api, "txStatus").mockResolvedValue({
      txHash: TX_HASH,
      found: true,
      confirmations: 2,
    });
    const onSettled = vi.fn();
    render(<TxStatus txHash={TX_HASH} onSettled={onSettled} />);
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("onDismiss renders a button that fires immediately, without waiting for confirmation", async () => {
    // Still unconfirmed — onSettled must NOT have fired.
    vi.spyOn(api, "txStatus").mockResolvedValue({
      txHash: TX_HASH,
      found: false,
      confirmations: 0,
    });
    const onSettled = vi.fn();
    const onDismiss = vi.fn();
    render(
      <TxStatus
        txHash={TX_HASH}
        onSettled={onSettled}
        onDismiss={onDismiss}
        dismissLabel="Back to Trade"
      />
    );
    const btn = await screen.findByText("Back to Trade");
    fireEvent.click(btn);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("shows the note next to the dismiss button when provided", async () => {
    vi.spyOn(api, "txStatus").mockResolvedValue({
      txHash: TX_HASH,
      found: false,
      confirmations: 0,
    });
    render(
      <TxStatus
        txHash={TX_HASH}
        onDismiss={() => {}}
        note="2 more batches won't be executed."
      />
    );
    expect(await screen.findByText("2 more batches won't be executed.")).toBeTruthy();
  });
});
