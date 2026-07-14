import {
  deserializeTxUnspentOutput,
  fromTxUnspentOutput,
} from "@meshsdk/core-cst";
import type { WalletUtxo } from "./types";

/**
 * Normalizes what the @meshsdk/react 2.0-beta wallet object returns.
 *
 * LIVE FINDING (a real user's Eternl connect): the beta's wallet object
 * (`MeshCardanoBrowserWallet`) exposes the RAW CIP-30 surface —
 * `getChangeAddress()` returns hex-encoded CBOR address bytes (e.g.
 * "007d0b6fd440…"), and `getUtxos()`/`getCollateral()` return CBOR hex
 * strings. Passing those to `deserializeAddress`/our backend fails, which
 * showed up as a bogus "no staking credential!" badge (the wallet DID have
 * staking — header byte 0x00 literally means base address with a stake key)
 * and as 400s from /tx/create-order. The class provides Mesh-typed variants
 * (`getChangeAddressBech32`, `getUtxosMesh`, `getCollateralMesh`) that this
 * adapter prefers, with type-checked fallbacks so a future non-beta wallet
 * object keeps working.
 */

interface WalletLike {
  getChangeAddressBech32?: () => Promise<string>;
  getChangeAddress: () => Promise<string>;
  getUtxosMesh?: () => Promise<unknown[]>;
  getUtxos: () => Promise<unknown[] | undefined>;
  getCollateralMesh?: () => Promise<unknown[]>;
  getCollateral?: () => Promise<unknown[] | undefined>;
  signTxReturnFullTx?: (tx: string, partialSign?: boolean) => Promise<string>;
  signTx: (tx: string, partialSign?: boolean) => Promise<string>;
  submitTx: (tx: string) => Promise<string>;
}

function isMeshUtxo(u: unknown): u is WalletUtxo {
  const x = u as WalletUtxo;
  return (
    typeof x === "object" &&
    x !== null &&
    typeof x.input?.txHash === "string" &&
    typeof x.output?.address === "string" &&
    Array.isArray(x.output?.amount)
  );
}

/** Raw CIP-30 API shape (the object `window.cardano[key].enable()`
 *  resolves to, before Mesh's wrapper) — just the one method we need here. */
interface Cip30Api {
  getUtxos: (
    amount?: string,
    paginate?: { page: number; limit: number }
  ) => Promise<string[] | null | undefined>;
}

const UTXO_PAGE_LIMIT = 100;
/** 200 pages * 100 = 20,000 UTxOs — far past any real wallet; stops a
 *  misbehaving wallet from looping forever. */
const MAX_UTXO_PAGES = 200;

/**
 * Page through the RAW CIP-30 getUtxos() ourselves.
 *
 * LIVE FINDING (a real user's Eternl wallet, ~16,850 tADA across many
 * UTxOs — this protocol litters a wallet with small deposit-refund UTxOs on
 * every cancel/take, so active users accumulate a lot of them): Mesh's own
 * `getUtxosMesh()`/`getUtxos()` wrapper (`@meshsdk/wallet`'s
 * MeshCardanoBrowserWallet) calls the injected wallet's `getUtxos()` with NO
 * arguments and returns whatever comes back verbatim — it doesn't paginate
 * and doesn't handle CIP-30's documented "response would be too large,
 * returns null, retry with paginate" case. Confirmed live: the backend
 * received only 16 UTxOs totaling ~59 ADA from a wallet the UI itself
 * reported holding 16,850 ADA — silently missing >99% of it, which then
 * surfaced three requests later as an opaque coin-selection failure instead
 * of here, where the actual cause is visible.
 *
 * Returns null (never a partial list) if paging doesn't look trustworthy —
 * e.g. a wallet that ignores `paginate` and returns the same page every
 * time — so the caller falls back to the old single-call behavior instead
 * of silently returning a truncated or duplicated set.
 */
async function fetchAllUtxoCborPaginated(
  raw: Cip30Api
): Promise<string[] | null> {
  const out: string[] = [];
  let prevFirst: string | undefined;
  for (let page = 0; page < MAX_UTXO_PAGES; page++) {
    const batch = await raw.getUtxos(undefined, {
      page,
      limit: UTXO_PAGE_LIMIT,
    });
    if (!batch || batch.length === 0) break;
    if (page > 0 && batch[0] === prevFirst) return null; // stuck — bail, don't dupe
    prevFirst = batch[0];
    out.push(...batch);
    if (batch.length < UTXO_PAGE_LIMIT) break; // short page = last page
  }
  return out;
}

export async function getChangeAddressBech32(wallet: unknown): Promise<string> {
  const w = wallet as WalletLike;
  const addr =
    typeof w.getChangeAddressBech32 === "function"
      ? await w.getChangeAddressBech32()
      : await w.getChangeAddress();
  if (!addr.startsWith("addr"))
    throw new Error(
      "wallet returned a raw (hex) change address and no bech32 accessor — unsupported wallet object shape"
    );
  return addr;
}

export async function getUtxosMesh(wallet: unknown): Promise<WalletUtxo[]> {
  const w = wallet as WalletLike;

  // Prefer paginating the wrapped wallet's RAW CIP-30 instance ourselves —
  // see fetchAllUtxoCborPaginated for why the "obvious" call below can
  // silently under-report a large wallet's UTxOs. `walletInstance` is an
  // undocumented field of Mesh's wrapper class, not part of its public
  // TS API, so this is defensive: any shape mismatch or thrown error just
  // falls through to the existing (known-safe, if sometimes incomplete)
  // path beneath it — never worse than before this existed.
  const rawRef = (w as { walletInstance?: unknown }).walletInstance;
  if (rawRef && typeof (rawRef as Cip30Api).getUtxos === "function") {
    try {
      const paged = await fetchAllUtxoCborPaginated(rawRef as Cip30Api);
      if (paged !== null) {
        const utxos = paged.map((hex) =>
          fromTxUnspentOutput(deserializeTxUnspentOutput(hex))
        );
        if (utxos.every(isMeshUtxo)) {
          console.info(
            `[walletAdapter] getUtxosMesh: paginated fetch got ${utxos.length} UTxO(s) from the raw CIP-30 instance.`
          );
          return utxos;
        }
        console.warn(
          "[walletAdapter] getUtxosMesh: paginated fetch decoded but failed isMeshUtxo shape check — falling back.",
          utxos
        );
      } else {
        console.warn(
          "[walletAdapter] getUtxosMesh: raw pagination looked stuck/unsupported (repeated page) — falling back to the unpaginated call."
        );
      }
    } catch (e) {
      // Never worse than before this existed — fall through to the plain
      // call below — but SURFACE why, since a silently-swallowed error here
      // is exactly what would make this fix look like it did nothing.
      console.warn(
        "[walletAdapter] getUtxosMesh: raw paginated fetch threw, falling back to the unpaginated call.",
        e
      );
    }
  } else {
    console.info(
      "[walletAdapter] getUtxosMesh: no raw walletInstance.getUtxos reachable on this wallet object — using the unpaginated call directly.",
      rawRef
    );
  }

  const raw =
    typeof w.getUtxosMesh === "function"
      ? await w.getUtxosMesh()
      : ((await w.getUtxos()) ?? []);
  if (!raw.every(isMeshUtxo))
    throw new Error(
      "wallet returned raw CBOR UTxOs and no Mesh-typed accessor — unsupported wallet object shape"
    );
  console.warn(
    `[walletAdapter] getUtxosMesh: fell back to the UNPAGINATED path — got ${raw.length} UTxO(s). If your wallet holds more than this, some are being silently dropped (docs/known issue).`
  );
  return raw;
}

export async function getCollateralMesh(
  wallet: unknown
): Promise<WalletUtxo | undefined> {
  const w = wallet as WalletLike;
  try {
    const raw =
      typeof w.getCollateralMesh === "function"
        ? await w.getCollateralMesh()
        : ((await w.getCollateral?.()) ?? []);
    const first = raw[0];
    return first !== undefined && isMeshUtxo(first) ? first : undefined;
  } catch {
    // Some wallets throw when no collateral is configured — treat as none.
    return undefined;
  }
}

/**
 * Sign returning the FULL signed transaction, then submit via the wallet.
 * Raw CIP-30 `signTx()` returns only a witness set (cbor of
 * transaction_witness_set) — submitting that directly would fail; the
 * wrapper's `signTxReturnFullTx()` assembles witnesses into the tx. Falls
 * back to plain signTx only if the variant is missing (older Mesh wallet
 * objects returned the full tx from signTx).
 */
export async function signAndSubmit(
  wallet: unknown,
  unsignedTxCborHex: string
): Promise<string> {
  const w = wallet as WalletLike;
  const signed =
    typeof w.signTxReturnFullTx === "function"
      ? await w.signTxReturnFullTx(unsignedTxCborHex, true)
      : await w.signTx(unsignedTxCborHex, true);
  return w.submitTx(signed);
}

/**
 * Fallback when the wallet has no collateral configured: a pure-ADA UTxO
 * (>= 5 ADA, no other assets) works as collateral. The backend excludes
 * whatever we designate from coin selection, so this is always safe — BUT
 * "safe" only holds if the UTxO is small. Returns the SMALLEST eligible one,
 * not just the first found: collateral only ever needs to cover a small
 * fraction of the tx fee, and picking an oversized one would permanently
 * exclude it from spending on every tx this app builds. (Same rule the e2e
 * harness uses — see e2e/smoke.ts.)
 */
export function findPureAdaUtxo(utxos: WalletUtxo[]): WalletUtxo | undefined {
  const eligible = utxos.filter(
    (u) =>
      u.output.amount.length === 1 &&
      u.output.amount[0]!.unit === "lovelace" &&
      BigInt(u.output.amount[0]!.quantity) >= 5_000_000n
  );
  return eligible.reduce<WalletUtxo | undefined>((smallest, u) => {
    if (!smallest) return u;
    const a = BigInt(u.output.amount[0]!.quantity);
    const b = BigInt(smallest.output.amount[0]!.quantity);
    return a < b ? u : smallest;
  }, undefined);
}

/** Collateral only needs to cover a small ledger-mandated fraction of the tx
 *  fee (preprod fees are well under 1 ADA even for complex Plutus txs) — a
 *  few ADA is always enough. 20 ADA is a generous cap with headroom. */
const MAX_REASONABLE_COLLATERAL_LOVELACE = 20_000_000n;

/**
 * Pick the collateral UTxO to actually use, guarding against a wallet
 * designating an oversized one.
 *
 * LIVE BUG: a real user's wallet reported a SINGLE ~16,683 ADA UTxO
 * (99.6% of the wallet's whole balance) as its collateral. attachCommon
 * correctly excludes whatever is designated as collateral from spending —
 * that's required, a tx can't spend its own collateral as a regular input —
 * but nothing checked whether the designation was reasonable. The wallet
 * reported no error, every other UTxO WAS fetched correctly (confirmed live
 * by comparing the backend's per-asset totals against the real on-chain
 * UTxO set — they matched exactly except for lovelace, off by precisely the
 * whale UTxO's amount), so this looked identical to a UTxO-fetching bug
 * from the outside. It wasn't — the fetch was fine; the exclusion was
 * correct; the SIZE of what got excluded was the bug.
 *
 * If the wallet-reported collateral looks oversized, prefer the smallest
 * eligible pure-ADA UTxO from the wallet's own set instead.
 */
export function pickCollateral(
  walletReported: WalletUtxo | undefined,
  utxos: WalletUtxo[]
): WalletUtxo | undefined {
  const lovelaceOf = (u: WalletUtxo) =>
    BigInt(u.output.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0");

  if (walletReported && lovelaceOf(walletReported) <= MAX_REASONABLE_COLLATERAL_LOVELACE) {
    return walletReported;
  }
  const smaller = findPureAdaUtxo(utxos);
  if (smaller) {
    if (walletReported) {
      console.warn(
        `[walletAdapter] pickCollateral: wallet-reported collateral holds ` +
          `${lovelaceOf(walletReported)} lovelace — too large to spend safely as ` +
          `collateral, using a smaller UTxO (${lovelaceOf(smaller)} lovelace) instead.`
      );
    }
    return smaller;
  }
  return walletReported; // nothing smaller available — better than nothing
}
