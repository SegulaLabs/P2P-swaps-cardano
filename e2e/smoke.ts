/**
 * LIVE PREPROD SMOKE TEST — docs/deployment.md §5 / open-questions #25.
 *
 * Plays the browser wallet's role with the throwaway wallets in e2e/wallets/
 * and exercises the REAL backend code (TxBuilder, OrderIndexer,
 * BlockfrostChainProvider) against the real preprod chain:
 *
 *   0. wallet A mints 1000 TESTA (plain native-script mint, user action)
 *   1. A creates an order: offer 100 TESTA, ask 5 tADA  -> on-chain checks
 *   2. indexer discovers + validates it
 *   3. wallet B takes it -> exact seller payment + deposit return + beacon burn
 *   4. A creates a second order, then cancels it (stake-key signature)
 *   5. indexer classifies both spends
 *
 * Requires: backend/.env with BLOCKFROST_PROJECT_ID_PREPROD, funded wallets.
 * Pass condition: exit 0 with "ALL CHECKS PASSED".
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
import { EmbeddedWallet } from "@meshsdk/wallet";
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
  confirmations: 1, // smoke test: 1 confirmation keeps the run short
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
  // Collateral: a pure-ADA UTxO >= 5 tADA (headless wallets have none marked).
  const collateral = findPureAdaUtxo(utxos);
  return { changeAddress, utxos, ...(collateral ? { collateral } : {}) };
}

/**
 * Every tx this harness submits touches a Plutus script, so a pure-ADA
 * collateral UTxO is mandatory (tx-builder.ts now fails fast without one —
 * a live finding: a wallet whose only UTxO mixes ADA with a native token has
 * NO valid collateral candidate at all). Real CIP-30 wallets keep one aside
 * automatically; headlessly, self-heal with a plain (script-free, so
 * collateral-free) ADA self-transfer that carves one out.
 */
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

/**
 * CancelOrder's redeemer requires the owner's STAKING key in
 * extra_signatories (mvp-contract-decisions.md §5). LIVE FINDING: Mesh's
 * MeshWallet.signTx() (via AppWallet -> EmbeddedWallet) always signs with
 * the PAYMENT key only — it never inspects required_signers and has no
 * public path to add a stake-key witness (confirmed from
 * @meshsdk/wallet source: AppWallet.signTx hardcodes accountType="payment").
 * A plain signAndSubmit() therefore fails on-chain with
 * MissingVKeyWitnessesUTXOW for the stake key hash.
 *
 * This is a Mesh headless-test-wallet gap, not proof the validator is wrong:
 * EmbeddedWallet DOES support accountType="stake" internally. We call it
 * directly here (reaching past MeshWallet's public surface, acceptable for
 * a test harness standing in for a wallet) to add the second witness and
 * prove the ON-CHAIN validator correctly accepts a stake-key signature when
 * one is actually provided. Whether real CIP-30 wallets (Eternl/Lace) fill
 * required_signers automatically must be verified separately — see
 * docs/open-questions.md.
 */
async function signWithStakeKeyAndSubmit(w: MeshWallet, unsignedHex: string): Promise<string> {
  const paymentSigned = await w.signTx(unsignedHex, true);
  const embedded = (w as unknown as { _wallet: EmbeddedWallet })._wallet;
  const stakeWitness = embedded.signTx(unsignedHex, 0, 0, "stake");
  const fullySigned = (
    EmbeddedWallet as unknown as {
      addWitnessSets: (tx: string, witnesses: unknown[]) => string;
    }
  ).addWitnessSets(paymentSigned, [stakeWitness]);
  return w.submitTx(fullySigned);
}

/**
 * Blockfrost's address-UTxO view lags a few seconds behind tx confirmation —
 * building against a stale wallet snapshot fails input selection (live
 * finding, open-questions #25). Wait until the wallet actually sees an
 * output of `txHash` before building the next transaction with it.
 */
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

/**
 * Blockfrost's secondary indices (a UTxO's consumed_by_tx flag, asset ->
 * addresses, asset -> transactions) can lag a few seconds behind primary
 * block confirmation (live finding — step 2's indexer discovery and this
 * spent-check both missed on the first try immediately after 1 confirmation,
 * then succeeded once given a little more time). Harmless in production
 * (the indexer polls continuously; tx-builder re-fetches per request), but
 * this test asserts state right after confirming, so retry briefly.
 */
async function waitUntil(label: string, predicate: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 12; i++) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.log(`  (${label}: still not settled after 2 minutes — Blockfrost index lag exceeded expected window)`);
  return false;
}

// --------------------------------------------------------------------- run

console.log(`\nPreprod smoke test — validator ${scripts.orderValidatorHash.slice(0, 8)}…, policy ${scripts.beaconPolicyId.slice(0, 8)}…`);
console.log(`  A (seller): ${addrA}\n  B (taker):  ${addrB}\n`);

// Pre-flight: both wallets must be faucet-funded (≥ 20 tADA each is plenty).
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

// Every tx below touches a Plutus script and needs real collateral; make
// sure both wallets have a pure-ADA UTxO set aside before anything else.
await ensureCollateral(walletA, "A");
await ensureCollateral(walletB, "B");

// ---- step 0: mint TESTA to wallet A (plain user-owned native policy)
const TESTA_NAME = "TESTA";
const forgeScript = ForgeScript.withOneSignature(addrA);
const testaPolicy = resolveScriptHash(forgeScript);
const testaUnit = testaPolicy + stringToHex(TESTA_NAME);
console.log(`step 0: mint 1000 TESTA (${testaUnit.slice(0, 16)}…) to wallet A`);

const balanceA = (await walletA.getUtxos()) as UTxO[];
const hasTesta = balanceA.some((u) => qty(u.output.amount, testaUnit) > 0n);
if (hasTesta) {
  console.log("  ✓ already minted (rerun) — skipping");
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

// ---- step 1: A creates an order — offer 100 TESTA, ask 5 tADA
console.log("step 1: create order (offer 100 TESTA, ask 5 tADA)");
const create = await txBuilder.buildCreateOrder({
  wallet: await walletCtx(walletA),
  offerAsset: `${testaPolicy}.${stringToHex(TESTA_NAME)}`,
  offerAmount: 100n,
  askAsset: "lovelace",
  askAmount: 5_000_000n,
});
check("summary warns not-audited/preprod", create.summary.warnings.length >= 3);
const createHash = await signAndSubmit(walletA, create.unsignedTxCborHex);
await waitForTx(createHash, "create-order");
await waitForWalletToSee(walletA, createHash, "create-order change");

// locate the order UTxO + verify on-chain shape
const createdTx = await provider.getTxUtxos(createHash);
const ownerStake = deserializeAddress(addrA).stakeCredentialHash;
const expectedOrderAddress = scripts.orderAddressFor(ownerStake);
const orderOutIndex = createdTx!.outputs.findIndex((o) => o.address === expectedOrderAddress);
check("order UTxO at owner-staked validator address", orderOutIndex >= 0);
const orderOut = createdTx!.outputs[orderOutIndex]!;
const beaconCount = orderOut.amount.filter((a) => a.unit.startsWith(scripts.beaconPolicyId)).length;
check("order holds exactly 5 beacons", beaconCount === 5, `found ${beaconCount}`);
check("order holds 100 TESTA", qty(orderOut.amount, testaUnit) === 100n);
check(
  `order holds the ${cfg.ORDER_DEPOSIT_LOVELACE} lovelace deposit`,
  qty(orderOut.amount, "lovelace") === cfg.ORDER_DEPOSIT_LOVELACE
);
const orderId = `${createHash}#${orderOutIndex}`;

// ---- step 2: indexer discovers it
console.log("step 2: indexer sync");
await waitUntil("indexer discovers the new order", async () => {
  await indexer.syncOnce();
  return (await repo.getOrder(orderId)) !== null;
});
const indexed = await repo.getOrder(orderId);
check("indexer discovered the order", indexed !== null);
check("indexed as open", indexed?.status === "open");
check("indexed owner == A's stake credential", indexed?.ownerStakeCredential === ownerStake);
check("indexed pair contains lovelace + TESTA", indexed?.pairId.includes("lovelace") === true);

// ---- step 3: B takes the order
console.log("step 3: take order from wallet B");
const bTestaBefore = qty(
  ((await walletB.getUtxos()) as UTxO[]).flatMap((u) => u.output.amount),
  testaUnit
);
const take = await txBuilder.buildTakeOrder({ wallet: await walletCtx(walletB), orderId });
check("take summary shows deposit return", take.summary.depositLovelace === cfg.ORDER_DEPOSIT_LOVELACE.toString());
const takeHash = await signAndSubmit(walletB, take.unsignedTxCborHex);
await waitForTx(takeHash, "take-order");

const takeTx = await provider.getTxUtxos(takeHash);
const paymentOuts = takeTx!.outputs.filter((o) => o.address === take.summary.paymentAddress);
check("exactly one seller payment output", paymentOuts.length === 1);
check(
  "seller receives ask + deposit lovelace",
  qty(paymentOuts[0]!.amount, "lovelace") >= 5_000_000n + cfg.ORDER_DEPOSIT_LOVELACE
);
check(
  "no beacons in any take output",
  takeTx!.outputs.every((o) => o.amount.every((a) => !a.unit.startsWith(scripts.beaconPolicyId)))
);
// Compare WALLET-WIDE balance, not this tx's outputs alone: when B's
// pre-existing TESTA-holding UTxO gets pulled in by coin selection (to help
// pay fees), its value folds into the change output too, contaminating any
// check scoped to "this tx's non-payment outputs" (live finding — with
// before=200 pre-existing, one run showed 300 in such outputs, not 100).
await waitForWalletToSee(walletB, takeHash, "take-order change");
const bTestaAfter = qty(
  ((await walletB.getUtxos()) as UTxO[]).flatMap((u) => u.output.amount),
  testaUnit
);
check(
  "B's TESTA balance increased by exactly 100 (the offer amount)",
  bTestaAfter - bTestaBefore === 100n,
  `before=${bTestaBefore} after=${bTestaAfter}`
);

await waitUntil("order UTxO shows spent", async () => (await provider.getUtxo(createHash, orderOutIndex)) === null);
check("order UTxO is spent", (await provider.getUtxo(createHash, orderOutIndex)) === null);
await waitUntil("indexer sees the take", async () => {
  await indexer.syncOnce();
  return (await repo.getOrder(orderId))?.status === "taken";
});
check("indexer classified the spend as taken", (await repo.getOrder(orderId))?.status === "taken");

// ---- step 4: A creates a second order and cancels it
console.log("step 4: create + cancel (stake-key authorization)");
const create2 = await txBuilder.buildCreateOrder({
  wallet: await walletCtx(walletA),
  offerAsset: `${testaPolicy}.${stringToHex(TESTA_NAME)}`,
  offerAmount: 50n,
  askAsset: "lovelace",
  askAmount: 3_000_000n,
});
const create2Hash = await signAndSubmit(walletA, create2.unsignedTxCborHex);
await waitForTx(create2Hash, "create-order #2");
await waitForWalletToSee(walletA, create2Hash, "create-order #2 change");
const created2 = await provider.getTxUtxos(create2Hash);
const order2Index = created2!.outputs.findIndex((o) => o.address === expectedOrderAddress);
const order2Id = `${create2Hash}#${order2Index}`;

// Classification only applies to orders the indexer has SEEN as open (it
// diffs "was open, now vanished" — order2 needs a discovery pass first,
// mirroring order #1's step 2, or there is nothing to reclassify later.
await waitUntil("indexer discovers order #2", async () => {
  await indexer.syncOnce();
  return (await repo.getOrder(order2Id)) !== null;
});

const cancel = await txBuilder.buildCancelOrder({ wallet: await walletCtx(walletA), orderId: order2Id });
// CancelOrder requires the owner's STAKE key in extra_signatories
// (mvp-contract-decisions.md §5) — MeshWallet's plain signTx() only signs
// with the payment key (see signWithStakeKeyAndSubmit doc comment above for
// the confirmed root cause), so use the stake-aware signer here.
const cancelHash = await signWithStakeKeyAndSubmit(walletA, cancel.unsignedTxCborHex);
await waitForTx(cancelHash, "cancel-order");

const cancelTx = await provider.getTxUtxos(cancelHash);
check(
  "no beacons in any cancel output",
  cancelTx!.outputs.every((o) => o.amount.every((a) => !a.unit.startsWith(scripts.beaconPolicyId)))
);
check("A got the 50 TESTA back", cancelTx!.outputs.some((o) => o.address === addrA && qty(o.amount, testaUnit) === 50n));
await waitUntil("order #2 UTxO shows spent", async () => (await provider.getUtxo(create2Hash, order2Index)) === null);
check("order #2 UTxO is spent", (await provider.getUtxo(create2Hash, order2Index)) === null);
await waitUntil("indexer sees the cancel", async () => {
  await indexer.syncOnce();
  return (await repo.getOrder(order2Id))?.status === "cancelled";
});
const order2Status = (await repo.getOrder(order2Id))?.status;
check("indexer classified the spend as cancelled", order2Status === "cancelled", `got ${order2Status}`);

// ------------------------------------------------------------------ result

console.log("");
if (failures === 0) {
  console.log("ALL CHECKS PASSED — live preprod smoke test complete (open-questions #25).");
} else {
  console.error(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
