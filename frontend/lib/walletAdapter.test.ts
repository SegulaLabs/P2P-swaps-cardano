// @vitest-environment node
//
// Real CBOR encode/decode (toTxUnspentOutput/fromTxUnspentOutput) below hits
// @cardano-sdk's bech32 address serialization, which throws under jsdom's
// separate global realm ("radix2.encode input should be Uint8Array" — a
// jsdom Buffer/Uint8Array cross-realm instanceof mismatch, not a real bug).
// This module has no DOM dependency, so plain node is also the more correct
// environment for it.
import { describe, expect, it } from "vitest";
import { toTxUnspentOutput } from "@meshsdk/core-cst";
import {
  findPureAdaUtxo,
  getChangeAddressBech32,
  getCollateralMesh,
  getUtxosMesh,
  pickCollateral,
  signAndSubmit,
} from "./walletAdapter";
import type { WalletUtxo } from "./types";

/**
 * Regression tests for the live finding: the @meshsdk/react 2.0-beta wallet
 * object exposes raw CIP-30 (hex) methods; the adapter must prefer the
 * Mesh/bech32 variants and never feed hex into the app.
 */

const meshUtxo = (lovelace: string, extraUnit?: string): WalletUtxo => ({
  input: { txHash: "d1".repeat(32), outputIndex: 0 },
  output: {
    address: "addr_test1qp7skm75gqj3hsk52jgxfufd4znf3ccmycdj0llyu38wqjgkfedku5jmmz0amt8jnpv7qu40m39mx54jhh7x3vh3tsaskhhmcd",
    amount: [
      { unit: "lovelace", quantity: lovelace },
      ...(extraUnit ? [{ unit: extraUnit, quantity: "1" }] : []),
    ],
  },
});

describe("walletAdapter (beta wallet raw-CIP30 normalization)", () => {
  it("prefers getChangeAddressBech32 over raw hex getChangeAddress", async () => {
    const wallet = {
      getChangeAddressBech32: async () => "addr_test1qp7skm75...",
      getChangeAddress: async () => "007d0b6fd440aabbcc", // raw hex — the bug
    };
    expect(await getChangeAddressBech32(wallet)).toBe("addr_test1qp7skm75...");
  });

  it("rejects hex-only wallets loudly instead of propagating hex", async () => {
    const wallet = { getChangeAddress: async () => "007d0b6fd440aabbcc" };
    await expect(getChangeAddressBech32(wallet)).rejects.toThrow(/hex/);
  });

  it("accepts bech32 from a legacy wallet without the variant", async () => {
    const wallet = { getChangeAddress: async () => "addr_test1legacy" };
    expect(await getChangeAddressBech32(wallet)).toBe("addr_test1legacy");
  });

  it("prefers getUtxosMesh; rejects raw CBOR string lists", async () => {
    const good = { getUtxosMesh: async () => [meshUtxo("5000000")], getUtxos: async () => ["82825820..."] };
    expect((await getUtxosMesh(good))[0]!.output.amount[0]!.unit).toBe("lovelace");

    const bad = { getUtxos: async () => ["82825820rawcbor"] };
    await expect(getUtxosMesh(bad)).rejects.toThrow(/CBOR/);
  });

  it("collateral: returns undefined when wallet has none or throws", async () => {
    expect(
      await getCollateralMesh({ getCollateralMesh: async () => [] })
    ).toBeUndefined();
    expect(
      await getCollateralMesh({
        getCollateralMesh: async () => {
          throw new Error("no collateral set");
        },
      })
    ).toBeUndefined();
  });

  it("findPureAdaUtxo skips token-carrying and dust UTxOs", () => {
    const utxos = [
      meshUtxo("94556710", "aa".repeat(28) + "5445535441"), // mixed — not eligible
      meshUtxo("1000000"), // dust — not eligible
      meshUtxo("5000000"), // eligible
    ];
    expect(findPureAdaUtxo(utxos)).toBe(utxos[2]);
    expect(findPureAdaUtxo(utxos.slice(0, 2))).toBeUndefined();
  });

  it("findPureAdaUtxo prefers the SMALLEST eligible UTxO, not the first", () => {
    // Live bug shape: a wallet's UTxO list has a huge pure-ADA UTxO ahead of
    // a small one — picking "first" would nominate the huge one as
    // collateral, permanently excluding almost the whole balance from every
    // tx this app builds.
    const utxos = [
      meshUtxo("16683436989"), // the whale — must NOT be picked
      meshUtxo("1000000"), // dust — not eligible
      meshUtxo("5000000"), // smallest eligible — must be picked
      meshUtxo("9000000"),
    ];
    expect(findPureAdaUtxo(utxos)).toBe(utxos[2]);
  });

  describe("pickCollateral", () => {
    it("trusts a reasonably-sized wallet-reported collateral", () => {
      const reported = meshUtxo("5000000");
      const utxos = [reported, meshUtxo("2000000")];
      expect(pickCollateral(reported, utxos)).toBe(reported);
    });

    it("live bug: overrides an oversized wallet-reported collateral with a small UTxO from the wallet's own set", () => {
      const whale = meshUtxo("16683436989"); // 99.6% of the wallet in one UTxO
      const small = meshUtxo("5000000");
      const utxos = [whale, meshUtxo("1000000"), small, meshUtxo("2000000")];
      expect(pickCollateral(whale, utxos)).toBe(small);
    });

    it("falls back to the (oversized) wallet-reported collateral when nothing smaller is available", () => {
      const whale = meshUtxo("16683436989");
      const utxos = [whale, meshUtxo("94556710", "aa".repeat(28) + "5445535441")];
      expect(pickCollateral(whale, utxos)).toBe(whale);
    });

    it("uses the smallest pure-ADA UTxO when the wallet reports no collateral at all", () => {
      const small = meshUtxo("5000000");
      const utxos = [meshUtxo("16683436989"), small];
      expect(pickCollateral(undefined, utxos)).toBe(small);
    });
  });

  it("pages through a wallet's RAW CIP-30 getUtxos instead of trusting a single unpaginated call", async () => {
    // Live bug: Mesh's own getUtxosMesh()/getUtxos() call the raw wallet with
    // NO arguments and return whatever comes back verbatim; a real Eternl
    // wallet with many UTxOs returned only a truncated first page that way
    // (16 UTxOs / ~59 ADA out of a wallet holding 16,850 ADA). Simulate a
    // wallet that only returns everything when explicitly paginated: 3
    // pages of 2, limit 2 (so the 3rd, undersized page signals "last page").
    const cbor = (i: number) =>
      toTxUnspentOutput(meshUtxo(`${(i + 1) * 1_000_000}`)).toCbor().toString();
    const allPages = [cbor(0), cbor(1), cbor(2), cbor(3), cbor(4)];
    const calls: unknown[] = [];
    const wallet = {
      getUtxos: async () => allPages.slice(0, 1), // the "obvious" unpaginated call: truncated
      walletInstance: {
        getUtxos: async (
          _amount: undefined,
          paginate?: { page: number; limit: number }
        ) => {
          calls.push(paginate);
          if (!paginate) return allPages.slice(0, 1); // matches Mesh's own broken call
          const { page, limit } = paginate;
          const slice = allPages.slice(page * limit, page * limit + limit);
          return slice.length > 0 ? slice : null;
        },
      },
    };
    const utxos = await getUtxosMesh(wallet);
    expect(utxos).toHaveLength(5); // NOT the truncated 1 from the unpaginated path
    // Called with an explicit {page, limit} from the start — never the bare,
    // unpaginated shape that truncated in the live bug.
    expect(calls[0]).toEqual({ page: 0, limit: 100 });
  });

  it("falls back to the plain call when the raw wallet ignores `paginate` (same full page every time)", async () => {
    // A full-size (== the 100-item page limit) page so the loop doesn't take
    // the short-page exit after page 0 — it must actually request page 1,
    // get the identical page back, and detect it's stuck.
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      toTxUnspentOutput({
        input: { txHash: "d1".repeat(32), outputIndex: i },
        output: { address: "addr_test1qp7skm75gqj3hsk52jgxfufd4znf3ccmycdj0llyu38wqjgkfedku5jmmz0amt8jnpv7qu40m39mx54jhh7x3vh3tsaskhhmcd", amount: [{ unit: "lovelace", quantity: "5000000" }] },
      }).toCbor().toString()
    );
    const wallet = {
      getUtxosMesh: async () => [meshUtxo("5000000")], // the safe fallback result
      walletInstance: {
        // Non-compliant: ignores `paginate`, always returns the same page.
        getUtxos: async () => fullPage,
      },
    };
    const utxos = await getUtxosMesh(wallet);
    // Must land on the fallback's ONE utxo, not 100 duplicated ones and not
    // an infinite loop.
    expect(utxos).toHaveLength(1);
  });

  it("falls back safely when walletInstance is missing or has no getUtxos", async () => {
    const good = { getUtxosMesh: async () => [meshUtxo("5000000")] };
    expect((await getUtxosMesh(good))).toHaveLength(1);

    const withUselessInstance = {
      getUtxosMesh: async () => [meshUtxo("5000000")],
      walletInstance: { notGetUtxos: true },
    };
    expect((await getUtxosMesh(withUselessInstance))).toHaveLength(1);
  });

  it("signAndSubmit uses signTxReturnFullTx (raw signTx returns a witness set)", async () => {
    const calls: string[] = [];
    const wallet = {
      signTxReturnFullTx: async (tx: string, partial?: boolean) => {
        calls.push(`full:${partial}`);
        return "fullsignedtx";
      },
      signTx: async () => {
        calls.push("raw");
        return "witnessSetOnly";
      },
      submitTx: async (tx: string) => {
        calls.push(`submit:${tx}`);
        return "ab".repeat(32);
      },
      getChangeAddress: async () => "",
      getUtxos: async () => [],
    };
    const hash = await signAndSubmit(wallet, "84a300");
    expect(hash).toBe("ab".repeat(32));
    expect(calls).toEqual(["full:true", "submit:fullsignedtx"]);
  });
});
