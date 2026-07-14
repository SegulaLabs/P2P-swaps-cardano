/**
 * Creates a resting two-sided order book around a chosen mid price on the
 * TESTA/lovelace pair, using 20 fresh throwaway wallets (not the existing
 * wallet-a-seller / wallet-b-taker, which keep their own separate orders).
 *
 * Mid price: 65,000 lovelace/TESTA. Spread: +/-10%, so all sell orders rest
 * at >= 71,500 lovelace/TESTA and all buy orders rest at <= 58,500
 * lovelace/TESTA — a 13,000 lovelace/TESTA gap between the inner edges means
 * the new orders can never cross/take each other.
 *
 * Funding: wallet-a-seller (has ~9870 tADA) funds every new wallet's ADA
 * (main + collateral) in one multi-output tx. wallet-b-taker (has ~545
 * TESTA) funds the 10 seller wallets' TESTA in a second multi-output tx.
 * Each new wallet then builds+signs+submits its own single create-order tx
 * (independent inputs, so these can fire without waiting on each other).
 *
 * Idempotent-ish like create-smart-fill-orders.ts: progress is written to
 * create-market-maker-orders.out.json and reruns skip completed steps.
 */
import {
  MeshWallet,
  Transaction,
  type Asset,
  type UTxO,
} from "@meshsdk/core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const HERE = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: join(HERE, "..", "backend", ".env") });

import { parseEnv } from "../backend/src/config.js";
import { loadProtocolScripts } from "../backend/src/protocol/blueprint.js";
import { BlockfrostChainProvider } from "../backend/src/services/chain-provider.js";
import { TxBuilder, type WalletContext } from "../backend/src/services/tx-builder.js";

const OUT_FILE = join(HERE, "create-market-maker-orders.out.json");
const MM_WALLETS_DIR = join(HERE, "wallets", "mm");
mkdirSync(MM_WALLETS_DIR, { recursive: true });

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

function loadFunderWallet(name: string): MeshWallet {
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

function loadOrCreateMmWallet(index: number): MeshWallet {
  const file = join(MM_WALLETS_DIR, `mm-${index}.json`);
  let words: string[];
  if (existsSync(file)) {
    words = (JSON.parse(readFileSync(file, "utf8")) as { mnemonic: string[] }).mnemonic;
  } else {
    words = MeshWallet.brew() as string[];
    writeFileSync(
      file,
      JSON.stringify(
        { network: "preprod", purpose: "throwaway market-maker test wallet — never reuse", mnemonic: words },
        null,
        2
      )
    );
  }
  return new MeshWallet({ networkId: 0, fetcher: provider.mesh, submitter: provider.mesh, key: { type: "mnemonic", words } });
}

const walletA = loadFunderWallet("wallet-a-seller"); // funds ADA (main + collateral) for all 20
const walletB = loadFunderWallet("wallet-b-taker"); // funds TESTA for the 10 seller wallets
await walletA.init();
await walletB.init();

const TESTA_POLICY = "05a9462c2ac98fe4f48d8f03f490e4ca32c1751a591c81751ba978a6";
const TESTA_NAME_HEX = "5445535441";
const TESTA = `${TESTA_POLICY}.${TESTA_NAME_HEX}`;

// --------------------------------------------------------------- order plan
//
// Mid = 65,000 lovelace/TESTA, +/-10% spread.
// Sellers (offer TESTA / ask lovelace): price >= 71,500, ascending.
// Buyers  (offer lovelace / ask TESTA): price <= 58,500, descending.

const DEPOSIT = 3_500_000n;
const FEE_BUFFER = 1_500_000n;
const COLLATERAL = 5_000_000n;
const MIN_ASSET_UTXO = 1_500_000n;

type Plan = {
  side: "sell" | "buy";
  price: bigint; // lovelace per TESTA
  testaAmount: bigint;
};

const sellPlans: Plan[] = [
  { side: "sell", price: 72_000n, testaAmount: 8n },
  { side: "sell", price: 76_000n, testaAmount: 10n },
  { side: "sell", price: 80_000n, testaAmount: 12n },
  { side: "sell", price: 85_000n, testaAmount: 15n },
  { side: "sell", price: 90_000n, testaAmount: 10n },
  { side: "sell", price: 96_000n, testaAmount: 20n },
  { side: "sell", price: 102_000n, testaAmount: 15n },
  { side: "sell", price: 108_000n, testaAmount: 10n },
  { side: "sell", price: 115_000n, testaAmount: 12n },
  { side: "sell", price: 125_000n, testaAmount: 18n },
];

const buyPlans: Plan[] = [
  { side: "buy", price: 58_000n, testaAmount: 5n },
  { side: "buy", price: 54_000n, testaAmount: 8n },
  { side: "buy", price: 50_000n, testaAmount: 6n },
  { side: "buy", price: 46_000n, testaAmount: 10n },
  { side: "buy", price: 42_000n, testaAmount: 8n },
  { side: "buy", price: 38_000n, testaAmount: 12n },
  { side: "buy", price: 34_000n, testaAmount: 10n },
  { side: "buy", price: 30_000n, testaAmount: 15n },
  { side: "buy", price: 26_000n, testaAmount: 12n },
  { side: "buy", price: 20_000n, testaAmount: 20n },
];

const plans: Plan[] = [...sellPlans, ...buyPlans]; // index 0-9 sell, 10-19 buy

console.log(`Mid price 65,000 lovelace/TESTA, +/-10% spread`);
console.log(`  sell floor: 71,500  (10 sell orders, 72,000 -> 125,000)`);
console.log(`  buy ceiling: 58,500 (10 buy orders, 58,000 -> 20,000)\n`);

// ------------------------------------------------------------------ resume

type FundingRecord = { done: boolean; txHash?: string };
type OrderRecord = { index: number; side: string; orderId?: string; txHash?: string };
type State = {
  fundingA?: FundingRecord;
  fundingB?: FundingRecord;
  orders: OrderRecord[];
};
const state: State = existsSync(OUT_FILE)
  ? (JSON.parse(readFileSync(OUT_FILE, "utf8")) as State)
  : { orders: [] };

function save() {
  writeFileSync(OUT_FILE, JSON.stringify(state, null, 2));
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

function findPureAdaUtxo(utxos: UTxO[], min: bigint): UTxO | undefined {
  return utxos.find(
    (u) =>
      u.output.amount.length === 1 &&
      u.output.amount[0]!.unit === "lovelace" &&
      BigInt(u.output.amount[0]!.quantity) >= min
  );
}

async function walletCtx(w: MeshWallet): Promise<WalletContext> {
  const changeAddress = await w.getChangeAddress();
  const utxos = (await w.getUtxos()) as UTxO[];
  const collateral = findPureAdaUtxo(utxos, 5_000_000n);
  return { changeAddress, utxos, ...(collateral ? { collateral } : {}) };
}

// ------------------------------------------------------------- mm wallets

const mmWallets: MeshWallet[] = [];
for (let i = 0; i < plans.length; i++) {
  const w = loadOrCreateMmWallet(i);
  await w.init();
  mmWallets.push(w);
}
const mmAddrs = mmWallets.map((w) => w.addresses.baseAddressBech32!);
console.log(`${mmWallets.length} market-maker wallets ready:`);
plans.forEach((p, i) => {
  console.log(
    `  mm-${i} (${p.side}): ${mmAddrs[i]!.slice(0, 20)}… — price ${p.price} lovelace/TESTA, ${p.testaAmount} TESTA`
  );
});

// ------------------------------------------------------------- funding A
//
// Two outputs per wallet: a "main" output sized for the order's ADA needs,
// and a separate 5 ADA collateral output (kept pure so it's never consumed
// as a spending input by the create-order tx's coin selection).

if (!state.fundingA?.done) {
  console.log(`\nFunding step A: sending ADA (main + collateral) to all ${plans.length} wallets…`);
  const tx = new Transaction({ initiator: walletA });
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i]!;
    const offerLovelace = p.side === "buy" ? p.price * p.testaAmount : 0n;
    const main = offerLovelace + DEPOSIT + FEE_BUFFER;
    tx.sendLovelace(mmAddrs[i]!, main.toString());
    tx.sendLovelace(mmAddrs[i]!, COLLATERAL.toString());
  }
  const unsigned = await tx.build();
  const txHash = await signAndSubmit(walletA, unsigned);
  state.fundingA = { done: false, txHash };
  save();
  await waitForTx(txHash, "funding-A");
  state.fundingA.done = true;
  save();
} else {
  console.log(`\nFunding step A already done (tx ${state.fundingA.txHash}).`);
}

// ------------------------------------------------------------- funding B
//
// TESTA for the 10 seller wallets (mm-0..mm-9), each output carrying the
// min-ADA that must accompany a native-asset UTxO.

if (!state.fundingB?.done) {
  console.log(`\nFunding step B: sending TESTA to the ${sellPlans.length} seller wallets…`);
  const tx = new Transaction({ initiator: walletB });
  for (let i = 0; i < sellPlans.length; i++) {
    const p = sellPlans[i]!;
    const assets: Asset[] = [
      { unit: "lovelace", quantity: MIN_ASSET_UTXO.toString() },
      { unit: TESTA.replace(".", ""), quantity: p.testaAmount.toString() },
    ];
    tx.sendAssets(mmAddrs[i]!, assets);
  }
  const unsigned = await tx.build();
  const txHash = await signAndSubmit(walletB, unsigned);
  state.fundingB = { done: false, txHash };
  save();
  await waitForTx(txHash, "funding-B");
  state.fundingB.done = true;
  save();
} else {
  console.log(`Funding step B already done (tx ${state.fundingB.txHash}).`);
}

// Make sure every mm wallet actually sees its funding outputs before we
// start coin-selecting against them.
// ------------------------------------------------------------- orders

if (state.orders.length === 0) {
  state.orders = plans.map((p, i) => ({ index: i, side: p.side }));
  save();
}

// Wallets whose order tx already confirmed have already spent their funding
// UTxOs — they'll never "see" those inputs as unspent again, so skip them.
console.log(`\nConfirming all wallets see their funding…`);
for (let i = 0; i < mmWallets.length; i++) {
  if (state.orders[i]!.txHash) continue;
  await waitForWalletToSee(mmWallets[i]!, state.fundingA!.txHash!, `mm-${i} funding-A`);
}
for (let i = 0; i < sellPlans.length; i++) {
  if (state.orders[i]!.txHash) continue;
  await waitForWalletToSee(mmWallets[i]!, state.fundingB!.txHash!, `mm-${i} funding-B`);
}

console.log(`\nCreating ${plans.length} orders (independent wallets — no inter-wait needed)…`);
for (let i = 0; i < plans.length; i++) {
  const rec = state.orders[i]!;
  if (rec.txHash) {
    console.log(`[${i + 1}/${plans.length}] mm-${i} (${rec.side}) already submitted (${rec.txHash}) — skipping`);
    continue;
  }
  const p = plans[i]!;
  const w = mmWallets[i]!;
  const offerAsset = p.side === "sell" ? TESTA : "lovelace";
  const askAsset = p.side === "sell" ? "lovelace" : TESTA;
  const offerAmount = p.side === "sell" ? p.testaAmount : p.price * p.testaAmount;
  const askAmount = p.side === "sell" ? p.price * p.testaAmount : p.testaAmount;

  console.log(
    `\n[${i + 1}/${plans.length}] mm-${i} ${p.side}: offer ${offerAmount} ${offerAsset === "lovelace" ? "lovelace" : "TESTA"}, ` +
      `ask ${askAmount} ${askAsset === "lovelace" ? "lovelace" : "TESTA"} (price ${p.price})`
  );

  const build = await txBuilder.buildCreateOrder({
    wallet: await walletCtx(w),
    offerAsset,
    offerAmount,
    askAsset,
    askAmount,
  });
  const txHash = await signAndSubmit(w, build.unsignedTxCborHex);
  rec.txHash = txHash;
  console.log(`  submitted: ${txHash}`);
  save();
}

// Resolve orderIds only after each tx is confirmed — getTxUtxos can't see an
// unconfirmed tx. No cross-wallet dependency, so this pass is just sequential
// polling, not sequential submission.
console.log(`\nWaiting for order txs to confirm and resolving order ids…`);
for (const rec of state.orders) {
  if (rec.orderId || !rec.txHash) continue;
  await waitForTx(rec.txHash, `mm-${rec.index} order`);
  const tx = await provider.getTxUtxos(rec.txHash);
  const orderOutIndex = tx!.outputs.findIndex((o) =>
    o.amount.some((a) => a.unit.startsWith(scripts.beaconPolicyId))
  );
  if (orderOutIndex < 0) throw new Error(`order output not found in tx ${rec.txHash}`);
  rec.orderId = `${rec.txHash}#${orderOutIndex}`;
  console.log(`  mm-${rec.index}: ${rec.orderId}`);
  save();
}

console.log(`\nDone — ${state.orders.filter((r) => r.orderId).length}/${plans.length} orders on-chain.`);
console.log(`Details saved to ${OUT_FILE}.`);
