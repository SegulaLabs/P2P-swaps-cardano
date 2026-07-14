import { describe, expect, it } from "vitest";
import { serializeData, type UTxO } from "@meshsdk/core";
import { loadProtocolScripts } from "../protocol/blueprint.js";
import { encodeOrderDatum, type OrderDatumFields } from "../protocol/datum.js";
import { deriveBeaconNames } from "../protocol/beacons.js";
import { MemoryOrdersRepo } from "../db/orders-repo.js";
import { OrderIndexer } from "./order-indexer.js";
import { BuildError, describeInsufficientFunds, TxBuilder } from "./tx-builder.js";
import type { ChainProvider } from "./chain-provider.js";

/**
 * Indexer validation + tx-builder guards, exercised with a synthetic but
 * fully consistent order UTxO (real scripts, real datum encoding, real
 * beacon derivation) and a mocked provider — no network.
 */

const scripts = loadProtocolScripts();
const OWNER = "01".repeat(28);
const ORDER_TX = "d1".repeat(32);

const DATUM: OrderDatumFields = {
  version: 1,
  beaconPolicyId: scripts.beaconPolicyId,
  ownerKeyHash: OWNER,
  paymentPubKeyHash: "03".repeat(28),
  paymentStakeKeyHash: null,
  offer: { policyId: "aa".repeat(28), assetNameHex: "544f4b41" },
  offerAmount: 100n,
  ask: { policyId: "bb".repeat(28), assetNameHex: "544f4b42" },
  askAmount: 250n,
  expiration: null,
  allowPartialFill: false,
};

function orderUtxo(overrides?: {
  datum?: OrderDatumFields;
  dropBeacon?: boolean;
  address?: string;
}): UTxO {
  const datum = overrides?.datum ?? DATUM;
  const names = deriveBeaconNames(datum.offer, datum.ask, datum.ownerKeyHash);
  const beaconUnits = Object.values(names).map((n) => ({
    unit: scripts.beaconPolicyId + n,
    quantity: "1",
  }));
  if (overrides?.dropBeacon) beaconUnits.pop();
  return {
    input: { txHash: ORDER_TX, outputIndex: 0 },
    output: {
      address: overrides?.address ?? scripts.orderAddressFor(datum.ownerKeyHash),
      amount: [
        { unit: "lovelace", quantity: "3500000" },
        {
          unit: datum.offer.policyId + datum.offer.assetNameHex,
          quantity: datum.offerAmount.toString(),
        },
        ...beaconUnits,
      ],
      plutusData: serializeData(encodeOrderDatum(datum), "Mesh"),
    },
  };
}

function fakeProvider(
  utxo: UTxO | null,
  extra?: Partial<ChainProvider>
): ChainProvider {
  return {
    name: "fake",
    mesh: {} as ChainProvider["mesh"],
    getUtxosByAddress: async () => (utxo ? [utxo] : []),
    getAssetAddresses: async () =>
      utxo ? [{ address: utxo.output.address, quantity: "1" }] : [],
    getUtxo: async () => utxo,
    getTxOutput: async () => utxo,
    getAssetMetadata: async () => null,
    getAssetTransactions: async () => [],
    getTxUtxos: async () => null,
    getSpendRedeemerConstructor: async () => null,
    getSpendRedeemers: async () => [],
    getTip: async () => ({ slot: 1000, height: 100 }),
    getTxConfirmations: async () => 10,
    submitTx: async () => "00".repeat(32),
    ...extra,
  };
}

const indexerOpts = {
  beaconPolicyId: scripts.beaconPolicyId,
  orderValidatorHash: scripts.orderValidatorHash,
  confirmations: 2,
  pollMs: 60_000,
};

describe("indexer validation (validateAndMap)", () => {
  const indexer = new OrderIndexer(
    fakeProvider(null),
    new MemoryOrdersRepo(),
    indexerOpts
  );

  it("accepts a fully consistent order UTxO", () => {
    const order = indexer.validateAndMap(orderUtxo());
    expect(order).not.toBeNull();
    expect(order!.orderId).toBe(`${ORDER_TX}#0`);
    expect(order!.ownerStakeCredential).toBe(OWNER);
    expect(order!.offeredAmount).toBe("100");
    expect(order!.requestedAmount).toBe("250");
    expect(order!.depositLovelace).toBe("3500000");
    expect(order!.paymentAddress.startsWith("addr_test1")).toBe(true);
  });

  it("rejects a UTxO missing a beacon", () => {
    expect(indexer.validateAndMap(orderUtxo({ dropBeacon: true }))).toBeNull();
  });

  it("rejects a UTxO at a foreign address", () => {
    expect(
      indexer.validateAndMap(
        orderUtxo({
          address:
            "addr_test1qqpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqcrqvpsxqc9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg9q5zs26pfmu",
        })
      )
    ).toBeNull();
  });

  it("rejects a stake credential that isn't the datum owner", () => {
    expect(
      indexer.validateAndMap(
        orderUtxo({ address: scripts.orderAddressFor("02".repeat(28)) })
      )
    ).toBeNull();
  });

  it("full sync upserts valid orders into the repo", async () => {
    const repo = new MemoryOrdersRepo();
    const idx = new OrderIndexer(fakeProvider(orderUtxo()), repo, indexerOpts);
    const result = await idx.syncOnce();
    expect(result.open).toBe(1);
    expect(await repo.listPairs()).toHaveLength(1);
  });
});

describe("tx-builder guards (pre-network)", () => {
  const builderWith = (utxo: UTxO | null) =>
    new TxBuilder(fakeProvider(utxo), scripts, {
      depositLovelace: 3_500_000n,
      referenceScript: undefined,
    });

  const wallet = {
    changeAddress: scripts.orderAddressFor(OWNER), // placeholder; per-test below
    utxos: [orderUtxo()],
  };

  it("take: 404s when the order UTxO is gone", async () => {
    await expect(
      builderWith(null).buildTakeOrder({
        wallet: { ...wallet, changeAddress: "addr_test1xyz" },
        orderId: `${ORDER_TX}#0`,
      })
    ).rejects.toMatchObject({ code: "order_not_found" });
  });

  it("take: rejects UTxOs without the full beacon set (fake orders)", async () => {
    await expect(
      builderWith(orderUtxo({ dropBeacon: true })).buildTakeOrder({
        wallet: { ...wallet, changeAddress: "addr_test1xyz" },
        orderId: `${ORDER_TX}#0`,
      })
    ).rejects.toMatchObject({ code: "not_an_order" });
  });

  it("take-many: rejects duplicate order ids", async () => {
    await expect(
      builderWith(orderUtxo()).buildTakeManyOrders({
        wallet: { ...wallet, changeAddress: "addr_test1xyz" },
        orders: [{ orderId: `${ORDER_TX}#0` }, { orderId: `${ORDER_TX}#0` }],
      })
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("take-many: enforces the batch cap", async () => {
    const b = new TxBuilder(fakeProvider(orderUtxo()), scripts, {
      depositLovelace: 3_500_000n,
      referenceScript: undefined,
      maxOrdersPerTx: 2,
    });
    await expect(
      b.buildTakeManyOrders({
        wallet: { ...wallet, changeAddress: "addr_test1xyz" },
        orders: [`${ORDER_TX}#0`, `${ORDER_TX}#1`, `${ORDER_TX}#2`].map((orderId) => ({ orderId })),
      })
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("take-many: rejects an empty batch", async () => {
    await expect(
      builderWith(orderUtxo()).buildTakeManyOrders({
        wallet: { ...wallet, changeAddress: "addr_test1xyz" },
        orders: [],
      })
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("take: refuses expired orders", async () => {
    const expired = { ...DATUM, expiration: Date.now() - 60_000 };
    await expect(
      builderWith(orderUtxo({ datum: expired })).buildTakeOrder({
        wallet: { ...wallet, changeAddress: "addr_test1xyz" },
        orderId: `${ORDER_TX}#0`,
      })
    ).rejects.toMatchObject({ code: "order_expired" });
  });

  it("create: enforces basic invariants before any network use", async () => {
    const b = builderWith(null);
    const base = {
      wallet: { ...wallet, changeAddress: "addr_test1xyz" },
      offerAsset: "lovelace",
      offerAmount: 5_000_000n,
      askAsset: `${"bb".repeat(28)}.544f4b42`,
      askAmount: 250n,
    };
    await expect(
      b.buildCreateOrder({ ...base, askAsset: "lovelace" })
    ).rejects.toMatchObject({ code: "invalid_request" }); // offer == ask
    await expect(
      b.buildCreateOrder({ ...base, offerAmount: 0n })
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      b.buildCreateOrder({ ...base, expiration: Date.now() - 1 })
    ).rejects.toMatchObject({ code: "invalid_request" });
    // change address without staking credential -> no owner identity
    await expect(b.buildCreateOrder(base)).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("cancel/take: reject malformed order ids", async () => {
    await expect(
      builderWith(null).buildCancelOrder({
        wallet: { ...wallet, changeAddress: "addr_test1xyz" },
        orderId: "nope",
      })
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("BuildError carries a machine-readable code", () => {
    expect(new BuildError("order_expired", "x").code).toBe("order_expired");
  });
});

describe("describeInsufficientFunds (live bug: '16k ADA' user hit bare 'UTxO Balance Insufficient')", () => {
  let nextIndex = 0;
  const utxo = (lovelace: string, extra: { unit: string; quantity: string }[] = []): UTxO => ({
    input: { txHash: "aa".repeat(32), outputIndex: nextIndex++ },
    output: {
      address: "addr_test1qxyz",
      amount: [{ unit: "lovelace", quantity: lovelace }, ...extra],
    },
  });

  it("returns null for unrelated errors — never masks a real bug", () => {
    expect(
      describeInsufficientFunds("TypeError: cannot read properties of undefined", {
        changeAddress: "addr_test1x",
        utxos: [utxo("5000000")],
      })
    ).toBeNull();
  });

  it("reports the actual lovelace total received, excluding collateral", () => {
    const wallet = {
      changeAddress: "addr_test1x",
      utxos: [utxo("2000000"), utxo("3000000")],
      collateral: utxo("5000000"),
    };
    const err = describeInsufficientFunds("UTxO Balance Insufficient", wallet);
    expect(err).not.toBeNull();
    expect(err!.code).toBe("insufficient_funds");
    // Only the two non-collateral UTxOs count: 2_000_000 + 3_000_000.
    expect(err!.message).toContain("2 spendable UTxO(s) totaling 5000000 lovelace");
    expect(err!.message).not.toContain("10000000"); // must NOT include collateral
  });

  it("surfaces a non-ADA shortfall too, so 'plenty of ADA' isn't assumed to be the whole story", () => {
    const wallet = {
      changeAddress: "addr_test1x",
      utxos: [utxo("16000000000", [{ unit: "aa".repeat(28) + "544f4b41", quantity: "3" }])],
    };
    const err = describeInsufficientFunds("UTxO Balance Insufficient", wallet);
    expect(err!.message).toContain("16000000000 lovelace");
    expect(err!.message).toContain("3 of " + "aa".repeat(28) + "544f4b41");
  });

  it("matches all four known cardano-sdk InputSelectionFailure strings", () => {
    const wallet = { changeAddress: "addr_test1x", utxos: [utxo("1000000")] };
    for (const failure of [
      "UTxO Balance Insufficient",
      "UTxO Not Fragmented Enough",
      "UTxO Fully Depleted",
      "Maximum Input Count Exceeded",
    ]) {
      expect(describeInsufficientFunds(failure, wallet)).not.toBeNull();
    }
  });
});

describe("v3 partial-fill builder guards (pre-network)", () => {
  const PARTIAL_DATUM: OrderDatumFields = { ...DATUM, allowPartialFill: true };
  const builderWith = (utxo: UTxO | null) =>
    new TxBuilder(fakeProvider(utxo), scripts, {
      depositLovelace: 3_500_000n,
      referenceScript: undefined,
    });
  const wallet = { changeAddress: "addr_test1xyz", utxos: [orderUtxo()] };
  const takeWith = (datum: OrderDatumFields, takeAmount: bigint) =>
    builderWith(orderUtxo({ datum })).buildTakeOrder({
      wallet,
      orderId: `${ORDER_TX}#0`,
      takeAmount,
    });

  it("rejects takeAmount on a full-fill-only order", async () => {
    await expect(takeWith(DATUM, 40n)).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("rejects takeAmount <= 0", async () => {
    await expect(takeWith(PARTIAL_DATUM, 0n)).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("rejects takeAmount >= the whole offer (use a full take)", async () => {
    await expect(takeWith(PARTIAL_DATUM, 100n)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(takeWith(PARTIAL_DATUM, 150n)).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("rejects a take that would exhaust the ask (ask' would hit 0)", async () => {
    // offer 100, ask 3: take 99 -> required = ceil(297/100) = 3 == ask.
    const tinyAsk = { ...PARTIAL_DATUM, askAmount: 3n };
    await expect(takeWith(tinyAsk, 99n)).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("accepts partial-enabled datums through the indexer", () => {
    const indexer = new OrderIndexer(
      fakeProvider(null),
      new MemoryOrdersRepo(),
      indexerOpts
    );
    const order = indexer.validateAndMap(orderUtxo({ datum: PARTIAL_DATUM }));
    expect(order).not.toBeNull();
    expect(order!.allowPartialFill).toBe(true);
  });
});

describe("v3 partial-fill spend classification + lineage", () => {
  const SPEND_TX = "e1".repeat(32);

  it("classifies constructor 2 as partially_filled, links AND immediately surfaces the continuation", async () => {
    const repo = new MemoryOrdersRepo();
    const utxo = orderUtxo({ datum: { ...DATUM, allowPartialFill: true } });
    // Seed the cache with the open order, then make it vanish from the
    // UTxO set so the sync pass classifies its spend.
    const seedIndexer = new OrderIndexer(fakeProvider(utxo), repo, indexerOpts);
    await seedIndexer.syncOnce();
    expect(await repo.listOpenOrderIds()).toEqual([`${ORDER_TX}#0`]);

    const continuationAddress = scripts.orderAddressFor(OWNER);
    const orderBeaconUnit =
      scripts.beaconPolicyId +
      deriveBeaconNames(DATUM.offer, DATUM.ask, OWNER).order;
    // The real continuation UTxO the partial fill produced: reduced datum
    // (offer 100 - take 40 = 60, ask 250 - required(40)=100 = 150), full
    // deposit, all 5 beacons — at SPEND_TX#1 with its inline datum, so the
    // indexer's getUtxo() can validate and surface it.
    const continuationDatum: OrderDatumFields = {
      ...DATUM,
      allowPartialFill: true,
      offerAmount: 60n,
      askAmount: 150n,
    };
    const continuationUtxo: UTxO = {
      input: { txHash: SPEND_TX, outputIndex: 1 },
      output: {
        address: continuationAddress,
        amount: [
          { unit: "lovelace", quantity: "3500000" },
          {
            unit: DATUM.offer.policyId + DATUM.offer.assetNameHex,
            quantity: "60",
          },
          ...Object.values(deriveBeaconNames(DATUM.offer, DATUM.ask, OWNER)).map(
            (n) => ({ unit: scripts.beaconPolicyId + n, quantity: "1" })
          ),
        ],
        plutusData: serializeData(encodeOrderDatum(continuationDatum), "Mesh"),
      },
    };
    const provider = fakeProvider(null, {
      getUtxo: async (txHash: string, index: number) =>
        txHash === SPEND_TX && index === 1 ? continuationUtxo : null,
      getTxUtxos: async (txHash: string) =>
        txHash === ORDER_TX
          ? {
              hash: ORDER_TX,
              inputs: [],
              outputs: [
                {
                  address: continuationAddress,
                  amount: [],
                  outputIndex: 0,
                  consumedByTx: SPEND_TX,
                },
              ],
            }
          : {
              hash: SPEND_TX,
              inputs: [
                { address: continuationAddress, txHash: ORDER_TX, outputIndex: 0 },
                { address: "addr_test1taker", txHash: "f0".repeat(32), outputIndex: 0 },
              ],
              outputs: [
                // payment output (no beacons) then the continuation
                {
                  address: "addr_test1seller",
                  amount: [{ unit: "lovelace", quantity: "1400000" }],
                  outputIndex: 0,
                  consumedByTx: null,
                },
                {
                  address: continuationAddress,
                  amount: [
                    { unit: "lovelace", quantity: "3500000" },
                    { unit: orderBeaconUnit, quantity: "1" },
                  ],
                  outputIndex: 1,
                  consumedByTx: null,
                },
              ],
            },
      getSpendRedeemers: async () => [
        {
          txIndex: 0,
          scriptHash: scripts.orderValidatorHash,
          constructor: 2,
          fields: [{ int: 40 }],
        },
      ],
    });
    const indexer = new OrderIndexer(provider, repo, indexerOpts);
    await indexer.syncOnce();

    const parent = await repo.getOrder(`${ORDER_TX}#0`);
    expect(parent!.status).toBe("partially_filled");
    expect(parent!.spentTxHash).toBe(SPEND_TX);
    expect(await repo.getLineage(`${SPEND_TX}#1`)).toEqual({
      parentOrderId: `${ORDER_TX}#0`,
      rootOrderId: `${ORDER_TX}#0`,
    });

    // The remainder must be visible in the SAME sync — no confirmation-lag
    // window where the seller's liquidity blinks out of the book.
    const child = await repo.getOrder(`${SPEND_TX}#1`);
    expect(child!.status).toBe("open");
    expect(child!.offeredAmount).toBe("60");
    expect(child!.requestedAmount).toBe("150");
    expect(child!.allowPartialFill).toBe(true);
    expect(child!.parentOrderId).toBe(`${ORDER_TX}#0`);
    expect(await repo.listOpenOrderIds()).toContain(`${SPEND_TX}#1`);
  });

  it("classifies constructor 1 as taken via the per-input redeemer", async () => {
    const repo = new MemoryOrdersRepo();
    const utxo = orderUtxo();
    await new OrderIndexer(fakeProvider(utxo), repo, indexerOpts).syncOnce();

    const provider = fakeProvider(null, {
      getTxUtxos: async (txHash: string) =>
        txHash === ORDER_TX
          ? {
              hash: ORDER_TX,
              inputs: [],
              outputs: [
                {
                  address: utxo.output.address,
                  amount: [],
                  outputIndex: 0,
                  consumedByTx: SPEND_TX,
                },
              ],
            }
          : {
              hash: SPEND_TX,
              inputs: [
                { address: utxo.output.address, txHash: ORDER_TX, outputIndex: 0 },
              ],
              outputs: [],
            },
      getSpendRedeemers: async () => [
        {
          txIndex: 0,
          scriptHash: scripts.orderValidatorHash,
          constructor: 1,
          fields: [],
        },
      ],
    });
    await new OrderIndexer(provider, repo, indexerOpts).syncOnce();
    expect((await repo.getOrder(`${ORDER_TX}#0`))!.status).toBe("taken");
  });

  it("cold start: recovers lineage for a continuation whose parent was never cached (e.g. after a cache/DB reset)", async () => {
    // Simulates the exact bug: the DB has NO memory of ORDER_TX#0 ever being
    // open — the only thing a fresh indexer discovers is the live
    // continuation UTxO. Its parent must be reconstructed from on-chain
    // history (getTxOutput), not from the (empty) cache.
    const parentDatum: OrderDatumFields = { ...DATUM, allowPartialFill: true };
    const parentUtxo = orderUtxo({ datum: parentDatum }); // ORDER_TX#0

    const continuationAddress = scripts.orderAddressFor(OWNER);
    const orderBeaconUnit =
      scripts.beaconPolicyId +
      deriveBeaconNames(DATUM.offer, DATUM.ask, OWNER).order;
    const continuationDatum: OrderDatumFields = {
      ...DATUM,
      allowPartialFill: true,
      offerAmount: 60n,
      askAmount: 150n,
    };
    const continuationUtxo: UTxO = {
      input: { txHash: SPEND_TX, outputIndex: 1 },
      output: {
        address: continuationAddress,
        amount: [
          { unit: "lovelace", quantity: "3500000" },
          {
            unit: DATUM.offer.policyId + DATUM.offer.assetNameHex,
            quantity: "60",
          },
          ...Object.values(deriveBeaconNames(DATUM.offer, DATUM.ask, OWNER)).map(
            (n) => ({ unit: scripts.beaconPolicyId + n, quantity: "1" })
          ),
        ],
        plutusData: serializeData(encodeOrderDatum(continuationDatum), "Mesh"),
      },
    };

    const repo = new MemoryOrdersRepo(); // fresh — never saw ORDER_TX#0
    const provider = fakeProvider(continuationUtxo, {
      // Only the parent's historical (already-spent) output is fetchable
      // this way — getUtxo() would correctly return null for it.
      getTxOutput: async (txHash: string, index: number) =>
        txHash === ORDER_TX && index === 0 ? parentUtxo : null,
      getTxUtxos: async (txHash: string) =>
        txHash === SPEND_TX
          ? {
              hash: SPEND_TX,
              inputs: [
                { address: continuationAddress, txHash: ORDER_TX, outputIndex: 0 },
                { address: "addr_test1taker", txHash: "f0".repeat(32), outputIndex: 0 },
              ],
              outputs: [
                {
                  address: "addr_test1seller",
                  amount: [{ unit: "lovelace", quantity: "1400000" }],
                  outputIndex: 0,
                  consumedByTx: null,
                },
                {
                  address: continuationAddress,
                  amount: [
                    { unit: "lovelace", quantity: "3500000" },
                    { unit: orderBeaconUnit, quantity: "1" },
                  ],
                  outputIndex: 1,
                  consumedByTx: null,
                },
              ],
            }
          : null, // ORDER_TX's own creation tx is unknown — it's the root
      getSpendRedeemers: async () => [
        {
          txIndex: 0,
          scriptHash: scripts.orderValidatorHash,
          constructor: 2,
          fields: [{ int: 40 }],
        },
      ],
    });

    await new OrderIndexer(provider, repo, indexerOpts).syncOnce();

    const child = await repo.getOrder(`${SPEND_TX}#1`);
    expect(child!.status).toBe("open");

    const parent = await repo.getOrder(`${ORDER_TX}#0`);
    expect(parent!.status).toBe("partially_filled");
    expect(parent!.spentTxHash).toBe(SPEND_TX);
    expect(parent!.offeredAmount).toBe("100"); // original size, recovered

    expect(await repo.getLineage(`${SPEND_TX}#1`)).toEqual({
      parentOrderId: `${ORDER_TX}#0`,
      rootOrderId: `${ORDER_TX}#0`,
    });
  });

  it("a genuinely fresh order (CreateOrder) is never mistaken for a continuation", async () => {
    const repo = new MemoryOrdersRepo();
    const utxo = orderUtxo(); // no partial-fill history at all
    const provider = fakeProvider(utxo, {
      getTxUtxos: async () => ({ hash: ORDER_TX, inputs: [], outputs: [] }),
      getSpendRedeemers: async () => [],
    });
    await new OrderIndexer(provider, repo, indexerOpts).syncOnce();
    expect(await repo.getLineage(`${ORDER_TX}#0`)).toBeNull();
    expect((await repo.getOrder(`${ORDER_TX}#0`))!.status).toBe("open");
  });
});
