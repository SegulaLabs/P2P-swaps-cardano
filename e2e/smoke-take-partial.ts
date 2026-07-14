/**
 * LIVE PREPROD SMOKE TEST — v3 PARTIAL FILLS (docs/partial-fills.md).
 *
 * Exercises the real backend code against real preprod, following the same
 * harness patterns (and live findings) as smoke.ts:
 *
 *   0. wallet A mints 1000 TESTA (skipped when already minted)
 *   1. A creates a PARTIAL-ENABLED order: offer 10 TESTA, ask 5 tADA
 *   2. indexer discovers it (allowPartialFill = true)
 *   3. B partially takes 4 TESTA -> tagged payment of ceil(4*5M/10) = 2 tADA,
 *      continuation UTxO at the same order address holding the deposit +
 *      6 TESTA + all 5 beacons under the reduced datum (checked field by
 *      field); indexer marks the parent partially_filled and links lineage
 *   4. B takes the continuation IN FULL -> remaining ask (3 tADA) + deposit
 *      returned in one payment, all beacons burned
 *
 * Requires: backend/.env with BLOCKFROST_PROJECT_ID_PREPROD, funded wallets
 * (see smoke.ts). Pass condition: exit 0 with "PARTIAL FILL SMOKE PASSED".
 */
import {
  ForgeScript,
  MeshWallet,
  Transaction,
  deserializeAddress,
  resolveScriptHash,
  stringToHex,
  type Asset,
  type UTxO,
} from "@meshsdk/core";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const HERE = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: join(HERE, "..", "backend", ".env") });

import { parseEnv } from "../backend/src/config.js";
import { loadProtocolScripts } from "../backend/src/protocol/blueprint.js";
import { decodeOrderDatum, requiredPayment } from "../backend/src/protocol/datum.js";
import { BlockfrostChainProvider } from "../backend/src/services/chain-provider.js";
import { TxBuilder, type WalletContext } from "../backend/src/services/tx-builder.js";
import { OrderIndexer } from "../backend/src/services/order-indexer.js";
import { MemoryOrdersRepo } from "../backend/src/db/orders-repo.js";

// ------------------------------------------------------------------- setup

const cfg = parseEnv(process.env);
if (!cfg.BLOCKFROST_PROJECT_ID_PREPROD) {
  console.error("backend/.env needs BLOCKFROST_PROJECT_ID_PREPROD");
  process.exit(1);
}
const provider = new BlockfrostChainProvider(cfg.BLOCKFROST_PROJECT_ID_PREPROD);
const scripts = loadProtocolScripts(cfg);
const txBuilder = new TxBuilder(provider, scripts, {
  depositLovelace: cfg.ORDER_DEPOSIT_LOVELACE,
  referenceScript: undefined,
});
const repo = new MemoryOrdersRepo();
const indexer = new OrderIndexer(provider, repo, {
  beaconPolicyId: scripts.beaconPolicyId,
  orderValidatorHash: scripts.orderValidatorHash,
  confirmations: 1,
  pollMs: 60_000,
});

function loadWallet(name: string): MeshWallet {
  const { mnemonic } = JSON.parse(
    readFileSync(join(HERE, "wallets", `${name}.json`), "utf8")
  ) as { mnemonic: string[] };
  return new MeshWallet({
    networkId: 0,
    fetcher: provider.mesh,
    submitter: provider.mesh,
    key: { type: "mnemonic", words: mnemonic },
  });
}

const walletA = loadWallet("wallet-a-seller");
const walletB = loadWallet("wallet-b-taker");
await walletA.init();
await walletB.init();
const addrA = walletA.addresses.baseAddressBech32!;
const addrB = walletB.addresses.baseAddressBech32!;

// ------------------------------------------------------------------ helpers
// (same shapes/live findings as smoke.ts — see the comments there)

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ✓" : "  ✗ FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function findPureAdaUtxo(utxos: UTxO[]): UTxO | undefined {
  return utxos.find(
    (u) =>
      u.output.amount.length === 1 &&
      u.output.amount[0]!.unit === "lovelace" &&
      BigInt(u.output.amount[0]!.quantity) >= 5_000_000n
  );
}

async function walletCtx(w: MeshWallet): Promise<WalletContext> {
  const changeAddress = await w.getChangeAddress();
  const utxos = (await w.getUtxos()) as UTxO[];
  if (utxos.length === 0)
    throw new Error(`wallet ${changeAddress.slice(0, 24)}… has no UTxOs — fund it from the faucet`);
  const collateral = findPureAdaUtxo(utxos);
  return { changeAddress, utxos, ...(collateral ? { collateral } : {}) };
}

async function ensureCollateral(w: MeshWallet, label: string): Promise<void> {
  const utxos = (await w.getUtxos()) as UTxO[];
  if (findPureAdaUtxo(utxos)) return;
  console.log(`  … wallet ${label} has no pure-ADA UTxO — splitting one out for collateral`);
  const address = await w.getChangeAddress();
  const tx = new Transaction({ initiator: w });
  tx.sendLovelace(address, "5000000");
  const unsigned = await tx.build();
  const hash = await signAndSubmit(w, unsigned);
  await waitForTx(hash, `${label} collateral split`);
  await waitForWalletToSee(w, hash, `${label} collateral split`);
}

async function waitForTx(txHash: string, label: string): Promise<void> {
  process.stdout.write(`  … waiting for ${label} (${txHash.slice(0, 12)}…) `);
  for (let i = 0; i < 60; i++) {
    const conf = await provider.getTxConfirmations(txHash);
    if (conf !== null && conf >= 1) {
      console.log(`confirmed (${conf})`);
      return;
    }
    await new Promise((r) => setTimeout(r, 10_000));
    process.stdout.write(".");
  }
  throw new Error(`tx ${txHash} not confirmed after 10 minutes`);
}

async function signAndSubmit(w: MeshWallet, unsignedHex: string): Promise<string> {
  const signed = await w.signTx(unsignedHex, true);
  return w.submitTx(signed);
}

async function waitForWalletToSee(w: MeshWallet, txHash: string, label: string): Promise<void> {
  process.stdout.write(`  … waiting for wallet to see ${label} outputs `);
  for (let i = 0; i < 30; i++) {
    const utxos = (await w.getUtxos()) as UTxO[];
    if (utxos.some((u) => u.input.txHash === txHash)) {
      console.log("ok");
      return;
    }
    await new Promise((r) => setTimeout(r, 8_000));
    process.stdout.write(".");
  }
  throw new Error(`wallet never saw outputs of ${txHash}`);
}

function qty(amount: Asset[], unit: string): bigint {
  return BigInt(amount.find((a) => a.unit === unit)?.quantity ?? "0");
}

async function waitUntil(label: string, predicate: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 12; i++) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.log(`  (${label}: still not settled after 2 minutes — Blockfrost index lag exceeded expected window)`);
  return false;
}

async function walletBalanceOf(w: MeshWallet, unit: string): Promise<bigint> {
  return qty(((await w.getUtxos()) as UTxO[]).flatMap((u) => u.output.amount), unit);
}

// --------------------------------------------------------------------- run

console.log(`\nPreprod PARTIAL FILL smoke test — validator ${scripts.orderValidatorHash.slice(0, 8)}…, policy ${scripts.beaconPolicyId.slice(0, 8)}…`);
console.log(`  A (seller): ${addrA}\n  B (taker):  ${addrB}\n`);

for (const [label, w, addr] of [
  ["A", walletA, addrA],
  ["B", walletB, addrB],
] as const) {
  const utxos = (await w.getUtxos()) as UTxO[];
  const lovelace = utxos.reduce((s, u) => s + qty(u.output.amount, "lovelace"), 0n);
  if (lovelace < 20_000_000n) {
    console.error(
      `wallet ${label} has ${lovelace} lovelace — fund ${addr} at https://docs.cardano.org/cardano-testnets/tools/faucet and rerun`
    );
    process.exit(2);
  }
  console.log(`  wallet ${label} balance: ${lovelace} lovelace ✓`);
}
console.log("");

await ensureCollateral(walletA, "A");
await ensureCollateral(walletB, "B");

// ---- step 0: mint TESTA to wallet A (skipped on rerun)
const TESTA_NAME = "TESTA";
const forgeScript = ForgeScript.withOneSignature(addrA);
const testaPolicy = resolveScriptHash(forgeScript);
const testaUnit = testaPolicy + stringToHex(TESTA_NAME);
console.log(`step 0: ensure wallet A holds TESTA (${testaUnit.slice(0, 16)}…)`);

const hasTesta = (await walletBalanceOf(walletA, testaUnit)) >= 10n;
if (hasTesta) {
  console.log("  ✓ TESTA present — skipping mint");
} else {
  const mintTx = new Transaction({ initiator: walletA });
  mintTx.mintAsset(forgeScript, {
    assetName: TESTA_NAME,
    assetQuantity: "1000",
    recipient: addrA,
  });
  const unsigned = await mintTx.build();
  const mintHash = await signAndSubmit(walletA, unsigned);
  await waitForTx(mintHash, "TESTA mint");
  await waitForWalletToSee(walletA, mintHash, "mint");
}

// ---- step 1: A creates a PARTIAL-ENABLED order: offer 10 TESTA, ask 5 tADA
const OFFER = 10n;
const ASK = 5_000_000n;
const TAKE = 4n;
const REQUIRED = requiredPayment(TAKE, ASK, OFFER); // 2_000_000
console.log(`step 1: create partial-enabled order (offer ${OFFER} TESTA, ask ${ASK} lovelace)`);
const create = await txBuilder.buildCreateOrder({
  wallet: await walletCtx(walletA),
  offerAsset: `${testaPolicy}.${stringToHex(TESTA_NAME)}`,
  offerAmount: OFFER,
  askAsset: "lovelace",
  askAmount: ASK,
  allowPartialFill: true,
});
check(
  "create summary mentions partial fills",
  /partial fills are enabled/i.test(create.summary.description)
);
const createHash = await signAndSubmit(walletA, create.unsignedTxCborHex);
await waitForTx(createHash, "create-order");
await waitForWalletToSee(walletA, createHash, "create-order change");

const createdTx = await provider.getTxUtxos(createHash);
const ownerStake = deserializeAddress(addrA).stakeCredentialHash;
const expectedOrderAddress = scripts.orderAddressFor(ownerStake);
const orderOutIndex = createdTx!.outputs.findIndex((o) => o.address === expectedOrderAddress);
check("order UTxO at owner-staked validator address", orderOutIndex >= 0);
const orderId = `${createHash}#${orderOutIndex}`;
const createdDatum = decodeOrderDatum(
  (await provider.getUtxo(createHash, orderOutIndex))!.output.plutusData!
);
check("on-chain datum has allow_partial_fill = true", createdDatum.allowPartialFill === true);

// ---- step 2: indexer discovers it
console.log("step 2: indexer sync");
await waitUntil("indexer discovers the new order", async () => {
  await indexer.syncOnce();
  return (await repo.getOrder(orderId)) !== null;
});
const indexed = await repo.getOrder(orderId);
check("indexer discovered the order", indexed !== null);
check("indexed as open with allowPartialFill", indexed?.allowPartialFill === true);

// ---- step 3: B partially takes 4 of 10 TESTA
console.log(`step 3: B partially takes ${TAKE} TESTA (pays ${REQUIRED} lovelace)`);
const bTestaBefore = await walletBalanceOf(walletB, testaUnit);
const partial = await txBuilder.buildTakeOrder({
  wallet: await walletCtx(walletB),
  orderId,
  takeAmount: TAKE,
});
check("summary action is take-order-partial", partial.summary.action === "take-order-partial");
check(
  "summary partialFills lists the leg",
  partial.summary.partialFills?.length === 1 &&
    partial.summary.partialFills[0]!.takeAmount === TAKE.toString() &&
    partial.summary.partialFills[0]!.paidAsk === REQUIRED.toString()
);
const partialHash = await signAndSubmit(walletB, partial.unsignedTxCborHex);
await waitForTx(partialHash, "partial take");

const partialTx = await provider.getTxUtxos(partialHash);
// 3a. the tagged seller payment: >= required lovelace at A's payment address
const paymentOuts = partialTx!.outputs.filter((o) => o.address === partial.summary.paymentAddress);
check("exactly one seller payment output", paymentOuts.length === 1);
check(
  `seller payment covers required (${REQUIRED}) — deposit NOT returned`,
  qty(paymentOuts[0]!.amount, "lovelace") >= REQUIRED &&
    qty(paymentOuts[0]!.amount, "lovelace") < cfg.ORDER_DEPOSIT_LOVELACE + REQUIRED
);
// 3b. the continuation order UTxO
const contIndex = partialTx!.outputs.findIndex(
  (o) =>
    o.address === expectedOrderAddress &&
    o.amount.some((a) => a.unit.startsWith(scripts.beaconPolicyId))
);
check("continuation UTxO exists at the order address", contIndex >= 0);
const cont = partialTx!.outputs[contIndex]!;
const contBeacons = cont.amount.filter((a) => a.unit.startsWith(scripts.beaconPolicyId));
check("continuation holds exactly 5 beacons", contBeacons.length === 5 && contBeacons.every((a) => a.quantity === "1"));
check(`continuation holds ${OFFER - TAKE} TESTA`, qty(cont.amount, testaUnit) === OFFER - TAKE);
check(
  "continuation keeps the full deposit",
  qty(cont.amount, "lovelace") === cfg.ORDER_DEPOSIT_LOVELACE
);
const contUtxo = await provider.getUtxo(partialHash, contIndex);
const contDatum = decodeOrderDatum(contUtxo!.output.plutusData!);
check("continuation datum: offer' = offer - take", contDatum.offerAmount === OFFER - TAKE);
check("continuation datum: ask' = ask - required", contDatum.askAmount === ASK - REQUIRED);
check(
  "continuation datum: all other fields identical",
  contDatum.version === createdDatum.version &&
    contDatum.beaconPolicyId === createdDatum.beaconPolicyId &&
    contDatum.ownerKeyHash === createdDatum.ownerKeyHash &&
    contDatum.paymentPubKeyHash === createdDatum.paymentPubKeyHash &&
    contDatum.paymentStakeKeyHash === createdDatum.paymentStakeKeyHash &&
    contDatum.expiration === createdDatum.expiration &&
    contDatum.allowPartialFill === true
);
// 3c. taker received exactly the taken amount
await waitForWalletToSee(walletB, partialHash, "partial-take change");
const bTestaAfterPartial = await walletBalanceOf(walletB, testaUnit);
check(
  `B's TESTA balance increased by exactly ${TAKE}`,
  bTestaAfterPartial - bTestaBefore === TAKE,
  `before=${bTestaBefore} after=${bTestaAfterPartial}`
);
// 3d. indexer classification + lineage
const contOrderId = `${partialHash}#${contIndex}`;
await waitUntil("indexer classifies the partial fill", async () => {
  await indexer.syncOnce();
  return (await repo.getOrder(orderId))?.status === "partially_filled";
});
check(
  "parent order is partially_filled",
  (await repo.getOrder(orderId))?.status === "partially_filled"
);
const lineage = await repo.getLineage(contOrderId);
check(
  "lineage links continuation -> parent (root = parent)",
  lineage?.parentOrderId === orderId && lineage?.rootOrderId === orderId,
  JSON.stringify(lineage)
);
// The continuation must be visible in the SAME sync that classified the
// parent — no confirmation-lag window where the remainder blinks out of the
// book (the fix for "the whole order disappeared after a partial fill").
const contIndexed = await repo.getOrder(contOrderId);
check(
  "continuation surfaced as open in the same sync (no vanish window)",
  contIndexed?.status === "open",
  `status=${contIndexed?.status ?? "missing"}`
);
check(
  "continuation indexed with reduced amounts",
  contIndexed?.offeredAmount === (OFFER - TAKE).toString() &&
    contIndexed?.requestedAmount === (ASK - REQUIRED).toString()
);
check("continuation carries lineage in the Order", contIndexed?.parentOrderId === orderId);

// ---- step 4: B takes the continuation IN FULL — deposit comes back
console.log("step 4: B takes the continuation in full (final fill returns the deposit)");
const finalTake = await txBuilder.buildTakeOrder({
  wallet: await walletCtx(walletB),
  orderId: contOrderId,
});
check("final take is a plain take-order", finalTake.summary.action === "take-order");
const finalHash = await signAndSubmit(walletB, finalTake.unsignedTxCborHex);
await waitForTx(finalHash, "final full take");

const finalTx = await provider.getTxUtxos(finalHash);
const finalPayments = finalTx!.outputs.filter((o) => o.address === finalTake.summary.paymentAddress);
check("exactly one final seller payment output", finalPayments.length === 1);
check(
  "final payment = remaining ask + full deposit",
  qty(finalPayments[0]!.amount, "lovelace") >= ASK - REQUIRED + cfg.ORDER_DEPOSIT_LOVELACE
);
check(
  "no beacons in any final-take output (all 5 burned)",
  finalTx!.outputs.every((o) => o.amount.every((a) => !a.unit.startsWith(scripts.beaconPolicyId)))
);
await waitForWalletToSee(walletB, finalHash, "final-take change");
const bTestaAtEnd = await walletBalanceOf(walletB, testaUnit);
check(
  `B ended with the full ${OFFER} TESTA across both fills`,
  bTestaAtEnd - bTestaBefore === OFFER,
  `before=${bTestaBefore} end=${bTestaAtEnd}`
);
await waitUntil("indexer sees the final take", async () => {
  await indexer.syncOnce();
  return (await repo.getOrder(contOrderId))?.status === "taken";
});
check(
  "indexer classified the continuation's spend as taken",
  (await repo.getOrder(contOrderId))?.status === "taken"
);

// ------------------------------------------------------------------ result

console.log("");
if (failures === 0) {
  console.log("PARTIAL FILL SMOKE PASSED — live preprod v3 partial-fill flow complete (docs/partial-fills.md).");
} else {
  console.error(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
