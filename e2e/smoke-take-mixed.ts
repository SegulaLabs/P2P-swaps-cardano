/**
 * LIVE PREPROD SMOKE TEST — v3 MIXED BATCH with TWIN partial fills
 * (docs/partial-fills.md §3 — the continuation rank-pairing design, exercised
 * as a positive test in exactly the shape it exists to make safe):
 *
 *   1. A creates THREE orders: two BYTE-IDENTICAL partial-enabled twins
 *      (offer 10 TESTA / ask 4 tADA each) + one plain full-fill-only order
 *      (offer 5 TESTA / ask 2 tADA)
 *   2. B consumes all three in ONE atomic transaction:
 *      full-take the plain order + partial-take twin1 (3) and twin2 (7)
 *   3. assert: one tx spent all three; THREE tagged payments (one per order);
 *      TWO continuation UTxOs at the order address, in the same relative
 *      order as the twins' inputs, each with exactly 5 beacons and the
 *      correct reduced datum (ask' = ask − required, NOT ask − paid: twin1's
 *      payment is min-ADA-topped-up above required); only the plain order's
 *      beacons burned; B's TESTA += 15; indexer classifies taken vs
 *      partially_filled per input and links both lineages.
 *
 * Requires: backend/.env with BLOCKFROST_PROJECT_ID_PREPROD, funded wallets.
 * Pass condition: exit 0 with "MIXED BATCH SMOKE PASSED".
 */
import {
  ForgeScript,
  MeshWallet,
  Transaction,
  deserializeAddress,
  deserializeDatum,
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

console.log(`\nPreprod MIXED BATCH smoke test — validator ${scripts.orderValidatorHash.slice(0, 8)}…, policy ${scripts.beaconPolicyId.slice(0, 8)}…`);
console.log(`  A (seller): ${addrA}\n  B (taker):  ${addrB}\n`);

await ensureCollateral(walletA, "A");
await ensureCollateral(walletB, "B");

// ---- step 0: ensure TESTA
const TESTA_NAME = "TESTA";
const forgeScript = ForgeScript.withOneSignature(addrA);
const testaPolicy = resolveScriptHash(forgeScript);
const testaUnit = testaPolicy + stringToHex(TESTA_NAME);
const testaAssetId = `${testaPolicy}.${stringToHex(TESTA_NAME)}`;
if ((await walletBalanceOf(walletA, testaUnit)) < 25n) {
  console.log("step 0: mint 1000 TESTA to wallet A");
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
} else {
  console.log("step 0: TESTA present — skipping mint");
}

// ---- step 1: create twins (partial-enabled, byte-identical datums) + plain
const TWIN_OFFER = 10n;
const TWIN_ASK = 4_000_000n;
const PLAIN_OFFER = 5n;
const PLAIN_ASK = 2_000_000n;
const TAKE_1 = 3n; // required = ceil(3*4M/10) = 1_200_000 (below min-ADA -> topped up)
const TAKE_2 = 7n; // required = ceil(7*4M/10) = 2_800_000
const REQ_1 = requiredPayment(TAKE_1, TWIN_ASK, TWIN_OFFER);
const REQ_2 = requiredPayment(TAKE_2, TWIN_ASK, TWIN_OFFER);

console.log("step 1: A creates twin partial orders + one plain order");
const orderIds: string[] = [];
const ownerStake = deserializeAddress(addrA).stakeCredentialHash;
const expectedOrderAddress = scripts.orderAddressFor(ownerStake);
for (const [label, offerAmount, askAmount, allowPartialFill] of [
  ["twin 1", TWIN_OFFER, TWIN_ASK, true],
  ["twin 2", TWIN_OFFER, TWIN_ASK, true],
  ["plain", PLAIN_OFFER, PLAIN_ASK, false],
] as const) {
  const create = await txBuilder.buildCreateOrder({
    wallet: await walletCtx(walletA),
    offerAsset: testaAssetId,
    offerAmount,
    askAsset: "lovelace",
    askAmount,
    allowPartialFill,
  });
  const hash = await signAndSubmit(walletA, create.unsignedTxCborHex);
  await waitForTx(hash, `create ${label}`);
  await waitForWalletToSee(walletA, hash, `create ${label} change`);
  const tx = await provider.getTxUtxos(hash);
  const idx = tx!.outputs.findIndex((o) => o.address === expectedOrderAddress);
  check(`${label} order created at the validator address`, idx >= 0);
  orderIds.push(`${hash}#${idx}`);
}
const [twin1, twin2, plain] = orderIds as [string, string, string];

// index all three before the batch so spends can be classified afterwards
await waitUntil("indexer discovers all three orders", async () => {
  await indexer.syncOnce();
  return (
    (await repo.getOrder(twin1)) !== null &&
    (await repo.getOrder(twin2)) !== null &&
    (await repo.getOrder(plain)) !== null
  );
});

// ---- step 2: ONE atomic tx — full-take plain + partial-take both twins
console.log("step 2: B takes all three in ONE tx (full + partial + partial)");
const bTestaBefore = await walletBalanceOf(walletB, testaUnit);
const batch = await txBuilder.buildTakeManyOrders({
  wallet: await walletCtx(walletB),
  orders: [
    { orderId: plain },
    { orderId: twin1, takeAmount: TAKE_1 },
    { orderId: twin2, takeAmount: TAKE_2 },
  ],
});
check("summary action is take-many-orders", batch.summary.action === "take-many-orders");
check("summary lists two partial fills", batch.summary.partialFills?.length === 2);
const batchHash = await signAndSubmit(walletB, batch.unsignedTxCborHex);
await waitForTx(batchHash, "mixed batch");

// ---- step 3: on-chain assertions
const batchTx = await provider.getTxUtxos(batchHash);
for (const id of orderIds) {
  const [h, i] = id.split("#");
  check(`order ${id.slice(0, 10)}… spent by the batch`, (await provider.getUtxo(h!, Number(i))) === null);
}

// tagged payments: read raw Blockfrost (getTxUtxos drops inline_datum)
const rawUtxos = (await (
  await fetch(
    `https://cardano-preprod.blockfrost.io/api/v0/txs/${batchHash}/utxos`,
    { headers: { project_id: cfg.BLOCKFROST_PROJECT_ID_PREPROD } }
  )
).json()) as {
  outputs: { address: string; amount: Asset[]; inline_datum: string | null }[];
};
function decodeTag(cbor: string): string | null {
  try {
    const root = deserializeDatum(cbor) as {
      fields: { fields: { bytes?: string; int?: bigint | number }[] }[];
    };
    const ref = root.fields[0]!;
    if (ref.fields?.[0]?.bytes === undefined || ref.fields?.[1]?.int === undefined) return null;
    return `${ref.fields[0]!.bytes}#${ref.fields[1]!.int}`;
  } catch {
    return null;
  }
}
const tagged = rawUtxos.outputs
  .filter((o) => o.address === addrA && o.inline_datum)
  .map((o) => ({ ...o, tag: decodeTag(o.inline_datum!) }))
  .filter((o) => o.tag !== null);
check("exactly three tagged seller payments", tagged.length === 3, `found ${tagged.length}`);
const payFor = (id: string) => tagged.find((t) => t.tag === id);
check(
  "plain payment = full ask + deposit",
  qty(payFor(plain)?.amount ?? [], "lovelace") >= PLAIN_ASK + cfg.ORDER_DEPOSIT_LOVELACE
);
check(
  `twin1 partial payment >= required ${REQ_1} (min-ADA topped up), no deposit`,
  qty(payFor(twin1)?.amount ?? [], "lovelace") >= REQ_1 &&
    qty(payFor(twin1)?.amount ?? [], "lovelace") < cfg.ORDER_DEPOSIT_LOVELACE
);
check(
  `twin2 partial payment >= required ${REQ_2}, no deposit`,
  qty(payFor(twin2)?.amount ?? [], "lovelace") >= REQ_2 &&
    qty(payFor(twin2)?.amount ?? [], "lovelace") < cfg.ORDER_DEPOSIT_LOVELACE
);

// TWO continuations, rank-paired: relative output order must equal the
// twins' relative INPUT order (ledger sorts inputs ascending by outref —
// same key the builder sorted by).
const contOutputs = batchTx!.outputs
  .map((o, i) => ({ ...o, index: i }))
  .filter(
    (o) =>
      o.address === expectedOrderAddress &&
      o.amount.some((a) => a.unit.startsWith(scripts.beaconPolicyId))
  );
check("exactly two continuation outputs", contOutputs.length === 2, `found ${contOutputs.length}`);
check(
  "no beacons anywhere else (plain order's 5 burned by conservation)",
  batchTx!.outputs.every(
    (o) =>
      o.address === expectedOrderAddress ||
      o.amount.every((a) => !a.unit.startsWith(scripts.beaconPolicyId))
  )
);
const sortedTwins = [
  { id: twin1, take: TAKE_1, required: REQ_1 },
  { id: twin2, take: TAKE_2, required: REQ_2 },
].sort((a, b) => {
  const [ha, ia] = a.id.split("#");
  const [hb, ib] = b.id.split("#");
  return ha! < hb! ? -1 : ha! > hb! ? 1 : Number(ia) - Number(ib);
});
for (let rank = 0; rank < 2; rank++) {
  const expected = sortedTwins[rank]!;
  const cont = contOutputs[rank]!;
  const beacons = cont.amount.filter((a) => a.unit.startsWith(scripts.beaconPolicyId));
  check(
    `continuation[${rank}] holds exactly 5 beacons`,
    beacons.length === 5 && beacons.every((a) => a.quantity === "1")
  );
  check(
    `continuation[${rank}] holds ${TWIN_OFFER - expected.take} TESTA + full deposit`,
    qty(cont.amount, testaUnit) === TWIN_OFFER - expected.take &&
      qty(cont.amount, "lovelace") === cfg.ORDER_DEPOSIT_LOVELACE
  );
  const datum = decodeOrderDatum(
    (await provider.getUtxo(batchHash, cont.index))!.output.plutusData!
  );
  check(
    `continuation[${rank}] datum reduced for its OWN twin (rank pairing): offer' = ${TWIN_OFFER - expected.take}, ask' = ask − required (not − paid)`,
    datum.offerAmount === TWIN_OFFER - expected.take &&
      datum.askAmount === TWIN_ASK - expected.required &&
      datum.allowPartialFill === true
  );
}

await waitForWalletToSee(walletB, batchHash, "batch change");
const bTestaAfter = await walletBalanceOf(walletB, testaUnit);
check(
  `B's TESTA increased by exactly ${PLAIN_OFFER + TAKE_1 + TAKE_2}`,
  bTestaAfter - bTestaBefore === PLAIN_OFFER + TAKE_1 + TAKE_2,
  `before=${bTestaBefore} after=${bTestaAfter}`
);

// ---- step 4: indexer classification per input + lineage
console.log("step 3: indexer classification");
await waitUntil("indexer classifies all three spends", async () => {
  await indexer.syncOnce();
  return (
    (await repo.getOrder(plain))?.status === "taken" &&
    (await repo.getOrder(twin1))?.status === "partially_filled" &&
    (await repo.getOrder(twin2))?.status === "partially_filled"
  );
});
check("plain classified taken", (await repo.getOrder(plain))?.status === "taken");
check("twin1 classified partially_filled", (await repo.getOrder(twin1))?.status === "partially_filled");
check("twin2 classified partially_filled", (await repo.getOrder(twin2))?.status === "partially_filled");
for (let rank = 0; rank < 2; rank++) {
  const childId = `${batchHash}#${contOutputs[rank]!.index}`;
  const lineage = await repo.getLineage(childId);
  check(
    `lineage[${rank}] links continuation to its own twin`,
    lineage?.parentOrderId === sortedTwins[rank]!.id,
    JSON.stringify(lineage)
  );
}

// ------------------------------------------------------------------ result

console.log("");
if (failures === 0) {
  console.log("MIXED BATCH SMOKE PASSED — twin partial fills + full fill in one atomic tx (docs/partial-fills.md §3).");
} else {
  console.error(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
