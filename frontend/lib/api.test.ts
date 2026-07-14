import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import type { SmartFillRoute } from "./types";

/**
 * Focused API-client test for the Smart Fill endpoint: the asset ids (which
 * contain a ".") and the raw bigint max spend must be URL-encoded into the
 * query correctly. fetch is stubbed — no network.
 */

const TOKEN = `${"bb".repeat(28)}.544f4b42`;

function stubFetch(body: unknown) {
  const fn = vi.fn(
    async (...args: unknown[]): Promise<Response> => {
      void args;
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("api.smartFill", () => {
  it("builds the smart-fill query with encoded asset ids and raw amount", async () => {
    const route: SmartFillRoute = {
      pairId: `${TOKEN}_lovelace`,
      spendAsset: "lovelace",
      receiveAsset: TOKEN,
      mode: "spend",
      requested: "1000000",
      legs: [],
      totalSpend: "0",
      totalReceive: "0",
      averagePrice: "",
      transactionCount: 0,
      maxOrdersPerTx: 8,
      atomic: false,
      candidateCount: 0,
      warnings: [],
    };
    const fn = stubFetch(route);

    const result = await api.smartFill({
      spendAsset: "lovelace",
      receiveAsset: TOKEN,
      maxSpend: "1000000",
    });

    expect(result).toEqual(route);
    const url = String(fn.mock.calls[0]![0]);
    expect(url).toContain("/smart-fill?");
    expect(url).toContain("spendAsset=lovelace");
    expect(url).toContain(`receiveAsset=${encodeURIComponent(TOKEN)}`);
    expect(url).toContain("maxSpend=1000000");
  });
});
