import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { parseEnv } from "./config.js";
import { loadProtocolScripts } from "./protocol/blueprint.js";
import { MemoryOrdersRepo } from "./db/orders-repo.js";
import { AssetMetadataService } from "./services/asset-metadata.js";

/**
 * HTTP surface tests with in-memory fakes and NO provider configured —
 * provider-backed endpoints must answer 503, never pretend.
 */

const wallet = {
  changeAddress:
    "addr_test1qqpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqc9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zs26pfmu",
  utxos: [
    {
      input: { txHash: "d1".repeat(32), outputIndex: 0 },
      output: {
        address: "addr_test1...",
        amount: [{ unit: "lovelace", quantity: "10000000" }],
      },
    },
  ],
};

describe("API (no provider)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      config: parseEnv({
        CARDANO_NETWORK: "preprod",
        DATABASE_URL: "postgres://unused",
      }),
      scripts: loadProtocolScripts(),
      repo: new MemoryOrdersRepo(),
      provider: null,
      txBuilder: null,
      indexer: null,
      assetMetadata: new AssetMetadataService(null, null),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health reports preprod and no custody", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "ok",
      network: "preprod",
      custody: "none",
    });
  });

  it("GET /pairs is empty initially", async () => {
    const res = await app.inject({ method: "GET", url: "/pairs" });
    expect(res.json()).toEqual({ pairs: [] });
  });

  it("GET /pairs/:pair/orderbook validates the pair format", async () => {
    const bad = await app.inject({
      method: "GET",
      url: "/pairs/not-a-pair/orderbook",
    });
    expect(bad.statusCode).toBe(400);
  });

  it("GET /orders/:orderId 404s on unknown order", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/orders/${encodeURIComponent(`${"d1".repeat(32)}#0`)}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /orders/by-owner validates the credential", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/orders/by-owner/nothex",
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /protocol/config exposes derived script identities", async () => {
    const res = await app.inject({ method: "GET", url: "/protocol/config" });
    const body = res.json();
    expect(body.network).toBe("preprod");
    expect(body.appVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.orderValidatorHash).toMatch(/^[0-9a-f]{56}$/);
    expect(body.beaconPolicyId).toMatch(/^[0-9a-f]{56}$/);
    expect(body.orderBeaconNameHex).toBe("6f72646572");
  });

  it("POST /tx/create-order validates the request body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/tx/create-order",
      payload: { wallet, offerAsset: "not-an-asset" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("POST /tx/create-order is 503 without a provider", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/tx/create-order",
      payload: {
        wallet,
        offerAsset: "lovelace",
        offerAmount: "5000000",
        askAsset: `${"bb".repeat(28)}.544f4b42`,
        askAmount: "250",
      },
    });
    expect(res.statusCode).toBe(503);
  });

  it.each(["cancel", "take"])(
    "POST /tx/%s-order validates orderId format",
    async (action) => {
      const res = await app.inject({
        method: "POST",
        url: `/tx/${action}-order`,
        payload: { wallet, orderId: "garbage" },
      });
      expect(res.statusCode).toBe(400);
    }
  );

  it("POST /tx/take-many-orders validates the body", async () => {
    const empty = await app.inject({
      method: "POST",
      url: "/tx/take-many-orders",
      payload: { wallet, orderIds: [] },
    });
    expect(empty.statusCode).toBe(400);
    const garbage = await app.inject({
      method: "POST",
      url: "/tx/take-many-orders",
      payload: { wallet, orderIds: ["garbage"] },
    });
    expect(garbage.statusCode).toBe(400);
  });

  it("POST /tx/take-many-orders is 503 without a provider", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/tx/take-many-orders",
      payload: { wallet, orderIds: [`${"d1".repeat(32)}#0`] },
    });
    expect(res.statusCode).toBe(503);
  });

  it("POST /tx/update-order is postponed (501)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/tx/update-order",
      payload: {},
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toMatch(/postponed/i);
  });

  it("POST /indexer/reindex is 503 without a provider", async () => {
    const res = await app.inject({ method: "POST", url: "/indexer/reindex" });
    expect(res.statusCode).toBe(503);
  });

  it("GET /smart-fill validates the query", async () => {
    const missing = await app.inject({ method: "GET", url: "/smart-fill" });
    expect(missing.statusCode).toBe(400);
    const same = await app.inject({
      method: "GET",
      url: "/smart-fill?spendAsset=lovelace&receiveAsset=lovelace&maxSpend=100",
    });
    expect(same.statusCode).toBe(400);
    // must provide exactly one of maxSpend / minReceive
    const both = await app.inject({
      method: "GET",
      url: `/smart-fill?spendAsset=lovelace&receiveAsset=${`${"bb".repeat(28)}.544f4b42`}&maxSpend=100&minReceive=5`,
    });
    expect(both.statusCode).toBe(400);
    const neither = await app.inject({
      method: "GET",
      url: `/smart-fill?spendAsset=lovelace&receiveAsset=${`${"bb".repeat(28)}.544f4b42`}`,
    });
    expect(neither.statusCode).toBe(400);
  });

  it("GET /smart-fill accepts a minReceive target", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/smart-fill?spendAsset=lovelace&receiveAsset=${`${"bb".repeat(28)}.544f4b42`}&minReceive=10`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe("receive");
  });

  it("GET /arbitrage scans the (empty) book without a provider", async () => {
    const res = await app.inject({ method: "GET", url: "/arbitrage" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.opportunities).toEqual([]);
    expect(body.scannedOrders).toBe(0);
    expect(body.warnings.length).toBeGreaterThan(0);
  });

  it("GET /smart-fill returns an empty, non-atomic route when the pair has no orders", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/smart-fill?spendAsset=lovelace&receiveAsset=${`${"bb".repeat(28)}.544f4b42`}&maxSpend=1000000`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.legs).toEqual([]);
    expect(body.transactionCount).toBe(0);
    expect(body.atomic).toBe(false);
    expect(body.warnings.length).toBeGreaterThan(0);
  });

  it("GET /assets/lovelace returns display metadata", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/lovelace" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ticker: "tADA", decimals: 6 });
  });

  it("GET /assets/:id validates the id format", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/garbage" });
    expect(res.statusCode).toBe(400);
  });
});
