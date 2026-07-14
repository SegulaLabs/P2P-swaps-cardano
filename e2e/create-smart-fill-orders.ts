/**
 * Seeds 20 real open orders on preprod (TESTA/lovelace pair) so Smart Fill has
 * a real order book with a price spread to route across. Uses the existing
 * throwaway wallets from e2e/wallets/ (same ones smoke.ts uses) as the
 * sellers; a separate wallet (e.g. Eternl) is the intended Smart Fill TAKER.
 *
 * Reuses the real TxBuilder/BlockfrostChainProvider — same code path as the
 * live smoke test, not a simulation. Each order is a separate on-chain
 * CreateOrder transaction, run sequentially (coin selection needs the
 * wallet's post-tx UTxO set — see waitForWalletToSee below).
 *
 * Idempotent-ish: writes progress to create-smart-fill-orders.out.json after
 * each order, and skips orders already recorded there on rerun.
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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const HERE = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: join(HERE, "..", "backend", ".env") });

import { parseEnv } from "../backend/src/config.js";
import { loadProtocolScripts } from "../backend/src/protocol/blueprint.js";
import { BlockfrostChainProvider } from "../backend/src/services/chain-provider.js";
import { TxBuilder, type WalletContext } from "../backend/src/services/tx-builder.js";

const OUT_FILE = join(HERE, "create-smart-fill-orders.out.json");

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

const walletA = loadWallet("wallet-a-seller"); // ~9930 tADA, 150 TESTA
const walletB = loadWallet("wallet-b-taker"); // ~61.7 tADA, 700 TESTA
await walletA.init();
await walletB.init();
const addrA = walletA.addresses.baseAddressBech32!;

// Same TESTA policy the smoke test minted to wallet A (native ForgeScript,
// deterministic from addrA — recomputed, not re-minted).
const TESTA_NAME = "TESTA";
const forgeScript = ForgeScript.withOneSignature(addrA);
const testaPolicy = resolveScriptHash(forgeScript);
const TESTA = `${testaPolicy}.${stringToHex(TESTA_NAME)}`;

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
  console.log(`  … wallet ${label} has no pure-ADA UTxO — splitting one out for collateral`);
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

// --------------------------------------------------------------- order plan
//
// Price spread on the SAME undirected pair (TESTA / lovelace) so Smart Fill
// has real cheapest-first routing choices in both directions:
//   - 17 orders OFFER TESTA / ASK lovelace (40,000 -> 140,000 lovelace/TESTA)
//   - 3  orders OFFER lovelace / ASK TESTA (the reverse side of the book)

type Plan = {
  wallet: "A" | "B";
  offerAsset: string;
  offerAmount: bigint;
  askAsset: string;
  askAmount: bigint;
  /** v3: roughly half the book opts in, so Smart Fill's marginal partial
   *  leg (docs/partial-fills.md §6) is exercised from the live UI. */
  allowPartialFill?: boolean;
};

const orders: Plan[] = [
  // wallet A sells TESTA (9 orders, 100 TESTA total of its 150)
  { wallet: "A", offerAsset: TESTA, offerAmount: 10n, askAsset: "lovelace", askAmount: 400_000n, allowPartialFill: true },
  { wallet: "A", offerAsset: TESTA, offerAmount: 15n, askAsset: "lovelace", askAmount: 675_000n },
  { wallet: "A", offerAsset: TESTA, offerAmount: 8n, askAsset: "lovelace", askAmount: 400_000n, allowPartialFill: true },
  { wallet: "A", offerAsset: TESTA, offerAmount: 12n, askAsset: "lovelace", askAmount: 660_000n },
  { wallet: "A", offerAsset: TESTA, offerAmount: 10n, askAsset: "lovelace", askAmount: 600_000n, allowPartialFill: true },
  { wallet: "A", offerAsset: TESTA, offerAmount: 15n, askAsset: "lovelace", askAmount: 975_000n },
  { wallet: "A", offerAsset: TESTA, offerAmount: 10n, askAsset: "lovelace", askAmount: 700_000n, allowPartialFill: true },
  { wallet: "A", offerAsset: TESTA, offerAmount: 10n, askAsset: "lovelace", askAmount: 750_000n },
  { wallet: "A", offerAsset: TESTA, offerAmount: 10n, askAsset: "lovelace", askAmount: 800_000n, allowPartialFill: true },
  // wallet B sells TESTA (8 orders, 155 TESTA total of its 700)
  { wallet: "B", offerAsset: TESTA, offerAmount: 20n, askAsset: "lovelace", askAmount: 1_700_000n, allowPartialFill: true },
  { wallet: "B", offerAsset: TESTA, offerAmount: 25n, askAsset: "lovelace", askAmount: 2_250_000n },
  { wallet: "B", offerAsset: TESTA, offerAmount: 20n, askAsset: "lovelace", askAmount: 1_900_000n, allowPartialFill: true },
  { wallet: "B", offerAsset: TESTA, offerAmount: 15n, askAsset: "lovelace", askAmount: 1_500_000n },
  { wallet: "B", offerAsset: TESTA, offerAmount: 30n, askAsset: "lovelace", askAmount: 3_300_000n, allowPartialFill: true },
  { wallet: "B", offerAsset: TESTA, offerAmount: 20n, askAsset: "lovelace", askAmount: 2_400_000n },
  { wallet: "B", offerAsset: TESTA, offerAmount: 15n, askAsset: "lovelace", askAmount: 1_950_000n, allowPartialFill: true },
  { wallet: "B", offerAsset: TESTA, offerAmount: 10n, askAsset: "lovelace", askAmount: 1_400_000n },
  // wallet A sells lovelace / asks TESTA — the reverse side of the book (3)
  { wallet: "A", offerAsset: "lovelace", offerAmount: 5_000_000n, askAsset: TESTA, askAmount: 60n, allowPartialFill: true },
  { wallet: "A", offerAsset: "lovelace", offerAmount: 3_000_000n, askAsset: TESTA, askAmount: 33n },
  { wallet: "A", offerAsset: "lovelace", offerAmount: 8_000_000n, askAsset: TESTA, askAmount: 100n, allowPartialFill: true },
];

// ------------------------------------------------------------------ resume

type Result = { index: number; wallet: string; orderId: string; txHash: string };
const results: Result[] = existsSync(OUT_FILE)
  ? (JSON.parse(readFileSync(OUT_FILE, "utf8")) as Result[])
  : [];
const done = new Set(results.map((r) => r.index));

function save() {
  writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
}

// --------------------------------------------------------------------- run

console.log(`Seeding ${orders.length} Smart Fill test orders on preprod (pair TESTA/lovelace)`);
console.log(`  TESTA unit: ${TESTA}`);
console.log(`  A (seller): ${addrA}`);
console.log(`  B (taker):  ${walletB.addresses.baseAddressBech32}\n`);
if (done.size > 0) console.log(`Resuming — ${done.size} order(s) already created.\n`);

await ensureCollateral(walletA, "A");
await ensureCollateral(walletB, "B");

// Wallet A owns the TESTA policy — top up if the seed plan (~110 TESTA for A)
// exceeds its free balance (earlier rounds locked/sold some).
{
  const testaUnit = testaPolicy + stringToHex(TESTA_NAME);
  const free = ((await walletA.getUtxos()) as UTxO[]).reduce(
    (s, u) => s + qty(u.output.amount, testaUnit),
    0n
  );
  if (free < 150n) {
    console.log(`wallet A has ${free} free TESTA — minting 1000 more`);
    const mintTx = new Transaction({ initiator: walletA });
    mintTx.mintAsset(forgeScript, {
      assetName: TESTA_NAME,
      assetQuantity: "1000",
      recipient: addrA,
    });
    const unsigned = await mintTx.build();
    const mintHash = await signAndSubmit(walletA, unsigned);
    await waitForTx(mintHash, "TESTA top-up mint");
    await waitForWalletToSee(walletA, mintHash, "TESTA mint");
  } else {
    console.log(`wallet A has ${free} free TESTA — no mint needed`);
  }
}

for (let i = 0; i < orders.length; i++) {
  if (done.has(i)) {
    console.log(`[${i + 1}/${orders.length}] already created (${results.find((r) => r.index === i)!.orderId}) — skipping`);
    continue;
  }
  const p = orders[i]!;
  const w = p.wallet === "A" ? walletA : walletB;
  const label = `order ${i + 1}/${orders.length} (wallet ${p.wallet}: offer ${p.offerAmount} ${p.offerAsset === "lovelace" ? "lovelace" : "TESTA"}, ask ${p.askAmount} ${p.askAsset === "lovelace" ? "lovelace" : "TESTA"})`;
  console.log(`\n[${i + 1}/${orders.length}] ${label}`);

  const build = await txBuilder.buildCreateOrder({
    wallet: await walletCtx(w),
    offerAsset: p.offerAsset,
    offerAmount: p.offerAmount,
    askAsset: p.askAsset,
    askAmount: p.askAmount,
    ...(p.allowPartialFill ? { allowPartialFill: true } : {}),
  });
  const txHash = await signAndSubmit(w, build.unsignedTxCborHex);
  await waitForTx(txHash, `create-order #${i + 1}`);

  const tx = await provider.getTxUtxos(txHash);
  const orderOutIndex = tx!.outputs.findIndex((o) =>
    o.amount.some((a) => a.unit.startsWith(scripts.beaconPolicyId))
  );
  if (orderOutIndex < 0) throw new Error(`order output not found in tx ${txHash}`);
  const orderId = `${txHash}#${orderOutIndex}`;
  console.log(`  order id: ${orderId}`);

  await waitForWalletToSee(w, txHash, `create-order #${i + 1} change`);

  results.push({ index: i, wallet: p.wallet, orderId, txHash });
  save();
}

console.log(`\nDone — ${results.length}/${orders.length} orders on-chain.`);
console.log(`Order ids saved to ${OUT_FILE}.`);
console.log(
  `\nNext: start the backend (npm run backend:dev) so its indexer discovers these\n` +
    `(or POST /indexer/reindex once it's up), then open the TESTA/lovelace pair\n` +
    `page in the frontend with Eternl connected and try Smart Fill.`
);
