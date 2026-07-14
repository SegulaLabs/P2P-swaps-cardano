/**
 * LIVE PREPROD SMOKE TEST — TakeManyOrders (protocol v2, docs/take-many-orders.md).
 *
 * The one thing this must prove: TWO orders settle in ONE atomic transaction.
 *
 *   1. wallet A creates order #1 (offer 5 TESTA, ask 0.2 tADA)
 *   2. wallet A creates order #2 (offer 7 TESTA, ask 0.35 tADA)
 *   3. wallet B takes BOTH via buildTakeManyOrders -> ONE tx
 *   4. on-chain checks: both order UTxOs spent by that single tx; TWO tagged
 *      payment outputs at A's payment address (each with an inline PaymentTag
 *      datum); zero beacons in any output; B's TESTA balance +12.
 *
 * Requires: backend/.env with BLOCKFROST_PROJECT_ID_PREPROD, funded wallets.
 * Pass condition: exit 0 with "ATOMIC BATCH TAKE PASSED".
 */
import {
  ForgeScript,
  MeshWallet,
  Transaction,
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
import { BlockfrostChainProvider } from "../backend/src/services/chain-provider.js";
import { TxBuilder, type WalletContext } from "../backend/src/services/tx-builder.js";

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
  maxOrdersPerTx: cfg.MAX_ORDERS_PER_TX,
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

const TESTA_NAME = "TESTA";
const forgeScript = ForgeScript.withOneSignature(addrA);
const testaPolicy = resolveScriptHash(forgeScript);
const testaUnit = testaPolicy + stringToHex(TESTA_NAME);
const TESTA = `${testaPolicy}.${stringToHex(TESTA_NAME)}`;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ✓" : "  ✗ FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function qty(amount: Asset[], unit: string): bigint {
  return BigInt(amount.find((a) => a.unit === unit)?.quantity ?? "0");
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
  const collateral = findPureAdaUtxo(utxos);
  return { changeAddress, utxos, ...(collateral ? { collateral } : {}) };
}

async function ensureCollateral(w: MeshWallet, label: string): Promise<void> {
  const utxos = (await w.getUtxos()) as UTxO[];
  if (findPureAdaUtxo(utxos)) return;
  console.log(`  … wallet ${label}: splitting out a collateral UTxO`);
  const address = await w.getChangeAddress();
  const tx = new Transaction({ initiator: w });
  tx.sendLovelace(address, "5000000");
  const unsigned = await tx.build();
  const hash = await signAndSubmit(w, unsigned);
  await waitForTx(hash, `${label} collateral split`);
  await waitForWalletToSee(w, hash, `${label} collateral split`);
}

async function signAndSubmit(w: MeshWallet, unsignedHex: string): Promise<string> {
  const signed = await w.signTx(unsignedHex, true);
  return w.submitTx(signed);
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

async function waitUntil(label: string, predicate: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 12; i++) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.log(`  (${label}: not settled after 2 minutes)`);
  return false;
}

async function createOrder(
  offerAmount: bigint,
  askLovelace: bigint,
  label: string
): Promise<string> {
  const res = await txBuilder.buildCreateOrder({
    wallet: await walletCtx(walletA),
    offerAsset: TESTA,
    offerAmount,
    askAsset: "lovelace",
    askAmount: askLovelace,
  });
  const hash = await signAndSubmit(walletA, res.unsignedTxCborHex);
  await waitForTx(hash, label);
  await waitForWalletToSee(walletA, hash, `${label} change`);
  const tx = await provider.getTxUtxos(hash);
  const idx = tx!.outputs.findIndex((o) =>
    o.amount.some((a) => a.unit.startsWith(scripts.beaconPolicyId))
  );
  if (idx < 0) throw new Error(`order output not found in ${hash}`);
  return `${hash}#${idx}`;
}

// --------------------------------------------------------------------- run

console.log(
  `\nTakeManyOrders smoke — v2 validator ${scripts.orderValidatorHash.slice(0, 8)}…, policy ${scripts.beaconPolicyId.slice(0, 8)}…`
);

await ensureCollateral(walletA, "A");
await ensureCollateral(walletB, "B");

console.log("step 1+2: wallet A creates two v2 orders");
const order1 = await createOrder(5n, 200_000n, "create-order #1");
console.log(`  order #1: ${order1}`);
const order2 = await createOrder(7n, 350_000n, "create-order #2");
console.log(`  order #2: ${order2}`);

console.log("step 3: wallet B takes BOTH orders in ONE transaction");
const bTestaBefore = qty(
  ((await walletB.getUtxos()) as UTxO[]).flatMap((u) => u.output.amount),
  testaUnit
);
const batch = await txBuilder.buildTakeManyOrders({
  wallet: await walletCtx(walletB),
  orderIds: [order1, order2],
});
check("summary action is take-many-orders", batch.summary.action === "take-many-orders");
check(
  "summary aggregates: 12 TESTA offered / 550000 lovelace asked",
  batch.summary.offered?.amount === "12" && batch.summary.requested?.amount === "550000",
  `${batch.summary.offered?.amount} / ${batch.summary.requested?.amount}`
);
const batchHash = await signAndSubmit(walletB, batch.unsignedTxCborHex);
console.log(`  ATOMIC TX: ${batchHash}`);
await waitForTx(batchHash, "atomic batch take");

console.log("step 4: on-chain verification");
const batchTx = await provider.getTxUtxos(batchHash);

// Both order UTxOs consumed by THIS one tx.
const [h1, i1] = order1.split("#") as [string, string];
const [h2, i2] = order2.split("#") as [string, string];
await waitUntil("order UTxOs spent", async () => {
  const a = await provider.getUtxo(h1, Number(i1));
  const b = await provider.getUtxo(h2, Number(i2));
  return a === null && b === null;
});
check("order #1 UTxO spent", (await provider.getUtxo(h1, Number(i1))) === null);
check("order #2 UTxO spent", (await provider.getUtxo(h2, Number(i2))) === null);

// Exactly TWO payment outputs at A's address, each carrying an inline
// PaymentTag datum naming the consumed order. The provider's getTxUtxos
// mapping drops inline_datum, so read Blockfrost's raw endpoint directly and
// DECODE each tag: Constr 0 [ Constr 0 [ bytes(orderTxHash), int(index) ] ].
const rawUtxos = (await (
  await fetch(
    `https://cardano-preprod.blockfrost.io/api/v0/txs/${batchHash}/utxos`,
    { headers: { project_id: cfg.BLOCKFROST_PROJECT_ID_PREPROD } }
  )
).json()) as {
  outputs: {
    address: string;
    amount: Asset[];
    inline_datum: string | null;
  }[];
};
const { deserializeDatum } = await import("@meshsdk/core");
function decodeTag(cbor: string): string {
  const root = deserializeDatum(cbor) as {
    fields: { fields: { bytes?: string; int?: bigint | number }[] }[];
  };
  const ref = root.fields[0]!;
  return `${ref.fields[0]!.bytes}#${ref.fields[1]!.int}`;
}
const tagged = rawUtxos.outputs
  .filter((o) => o.address === addrA && o.inline_datum)
  .map((o) => ({ ...o, tag: decodeTag(o.inline_datum!) }));
check(
  "exactly two tagged seller payments at A's address",
  tagged.length === 2,
  `found ${tagged.length}`
);
check(
  "tags name exactly the two consumed orders",
  new Set(tagged.map((t) => t.tag)).size === 2 &&
    tagged.every((t) => t.tag === order1 || t.tag === order2),
  tagged.map((t) => t.tag.slice(0, 12)).join(", ")
);
const paidLovelace = tagged
  .map((o) => qty(o.amount, "lovelace"))
  .sort((a, b) => (a < b ? -1 : 1));
check(
  "payment #1 = ask 200000 + deposit",
  paidLovelace[0] === 200_000n + cfg.ORDER_DEPOSIT_LOVELACE,
  String(paidLovelace[0])
);
check(
  "payment #2 = ask 350000 + deposit",
  paidLovelace[1] === 350_000n + cfg.ORDER_DEPOSIT_LOVELACE,
  String(paidLovelace[1])
);
check(
  "no beacons in ANY output of the batch tx",
  batchTx!.outputs.every((o) =>
    o.amount.every((a) => !a.unit.startsWith(scripts.beaconPolicyId))
  )
);

await waitForWalletToSee(walletB, batchHash, "batch take change");
const bTestaAfter = qty(
  ((await walletB.getUtxos()) as UTxO[]).flatMap((u) => u.output.amount),
  testaUnit
);
check(
  "B's TESTA balance increased by exactly 12 (5 + 7)",
  bTestaAfter - bTestaBefore === 12n,
  `before=${bTestaBefore} after=${bTestaAfter}`
);

console.log("");
if (failures === 0) {
  console.log(`ATOMIC BATCH TAKE PASSED — two orders settled in one tx: ${batchHash}`);
} else {
  console.error(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
