/**
 * Gives each of the 20 mm-* wallets (e2e/wallets/mm/) a varied 2-sell + 2-buy
 * order set on the TESTA/lovelace pair, under the CURRENT protocol config
 * (v2 — order creation itself is unchanged from v1, only TakeManyOrders is
 * new; loadProtocolScripts() picks up the current beacon policy / validator
 * hash automatically from backend/.env + the compiled blueprint).
 *
 * Scope: mm-* wallets only. wallet-a-seller / wallet-b-taker are left alone
 * — they're mid-progress on the separate create-smart-fill-orders.ts reseed.
 *
 * Funding: two multi-output txs from wallet-a-seller (ADA top-up for all 20
 * wallets' 4 orders each; TESTA for each wallet's 2 sell orders). Then a
 * 4-round round-robin: round r submits order slot r for ALL 20 wallets, then
 * waits for every tx in that round to confirm before round r+1 — a wallet's
 * own orders must be sequential (same UTxOs), but different wallets don't
 * depend on each other, so batching by round is much faster than fully
 * serial per-wallet.
 *
 * Idempotent-ish: progress written to create-mm-v2-variety-orders.out.json.
 */
import { MeshWallet, Transaction, type Asset, type UTxO } from "@meshsdk/core";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const HERE = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: join(HERE, "..", "backend", ".env") });

import { parseEnv } from "../backend/src/config.js";
import { loadProtocolScripts } from "../backend/src/protocol/blueprint.js";
import { BlockfrostChainProvider } from "../backend/src/services/chain-provider.js";
import { TxBuilder, type WalletContext } from "../backend/src/services/tx-builder.js";

const OUT_FILE = join(HERE, "create-mm-v2-variety-orders.out.json");
const MM_DIR = join(HERE, "wallets", "mm");

const cfg = parseEnv(process.env);
if (!cfg.BLOCKFROST_PROJECT_ID_PREPROD) {
  console.error("backend/.env needs BLOCKFROST_PROJECT_ID_PREPROD");
  process.exit(1);
}
const provider = new BlockfrostChainProvider(cfg.BLOCKFROST_PROJECT_ID_PREPROD);
const scripts = loadProtocolScripts(cfg);
console.log(`protocol config: orderValidatorHash=${scripts.orderValidatorHash} beaconPolicyId=${scripts.beaconPolicyId}`);
const txBuilder = new TxBuilder(provider, scripts, {
  depositLovelace: cfg.ORDER_DEPOSIT_LOVELACE,
  referenceScript: undefined,
});

function loadWallet(dir: string, name: string): MeshWallet {
  const { mnemonic } = JSON.parse(
    readFileSync(join(HERE, "wallets", dir, `${name}.json`), "utf8")
  ) as { mnemonic: string[] };
  return new MeshWallet({
    networkId: 0,
    fetcher: provider.mesh,
    submitter: provider.mesh,
    key: { type: "mnemonic", words: mnemonic },
  });
}

const walletA = loadWallet(".", "wallet-a-seller");
await walletA.init();

const TESTA_POLICY = "05a9462c2ac98fe4f48d8f03f490e4ca32c1751a591c81751ba978a6";
const TESTA_NAME_HEX = "5445535441";
const TESTA = `${TESTA_POLICY}.${TESTA_NAME_HEX}`;

const mmNames = readdirSync(MM_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(".json", ""))
  .sort((a, b) => parseInt(a.match(/\d+/)![0]!, 10) - parseInt(b.match(/\d+/)![0]!, 10));

const mmWallets = mmNames.map((n) => loadWallet("mm", n));
for (const w of mmWallets) await w.init();
const mmAddrs = mmWallets.map((w) => w.addresses.baseAddressBech32!);
console.log(`${mmWallets.length} mm wallets: ${mmNames.join(", ")}`);

// --------------------------------------------------------------- order plan
//
// 2 sell + 2 buy per wallet, laddered across all wallets for variety:
//   sells: 72,000 -> ~150,000 lovelace/TESTA ascending (>= mid*1.10 floor)
//   buys:  58,000 -> ~11,200 lovelace/TESTA descending (<= mid*0.90 ceiling)
// Quantities vary 5-20 TESTA via a simple deterministic spread.

const N = mmWallets.length;
const SELL_COUNT = N * 2;
const BUY_COUNT = N * 2;
const sellPrices = Array.from({ length: SELL_COUNT }, (_, k) => 72_000n + BigInt(k) * 2_000n);
const buyPrices = Array.from({ length: BUY_COUNT }, (_, k) => 58_000n - BigInt(k) * 1_200n);
const qtyFor = (k: number) => BigInt(5 + ((k * 7) % 16)); // 5..20

type OrderPlan = { side: "sell" | "buy"; price: bigint; testaAmount: bigint };
type WalletPlan = { name: string; sells: OrderPlan[]; buys: OrderPlan[] };

const walletPlans: WalletPlan[] = mmNames.map((name, i) => ({
  name,
  sells: [0, 1].map((j) => {
    const k = i * 2 + j;
    return { side: "sell" as const, price: sellPrices[k]!, testaAmount: qtyFor(k) };
  }),
  buys: [0, 1].map((j) => {
    const k = i * 2 + j;
    return { side: "buy" as const, price: buyPrices[k]!, testaAmount: qtyFor(k + 100) };
  }),
}));

console.log(`\nPlan: ${N} wallets x (2 sell + 2 buy) = ${N * 4} orders`);
for (const wp of walletPlans.slice(0, 3)) {
  console.log(
    `  ${wp.name}: sell ${wp.sells.map((p) => `${p.testaAmount}@${p.price}`).join(", ")} | ` +
      `buy ${wp.buys.map((p) => `${p.testaAmount}@${p.price}`).join(", ")}`
  );
}
console.log(`  … (${N - 3} more)`);

const DEPOSIT = 3_500_000n;
const SAFETY_MARGIN = 8_000_000n; // covers 4 tx fees + min-change on the buy legs
const MIN_ASSET_UTXO = 1_500_000n;

// ------------------------------------------------------------------ resume

type OrderRecord = { side: "sell" | "buy"; slot: number; price: string; qty: string; txHash?: string; orderId?: string };
type State = {
  fundingAda?: { done: boolean; txHash?: string };
  fundingTesta?: { done: boolean; txHash?: string };
  wallets: Record<string, OrderRecord[]>;
};
const state: State = existsSync(OUT_FILE)
  ? (JSON.parse(readFileSync(OUT_FILE, "utf8")) as State)
  : { wallets: {} };

function save() {
  writeFileSync(OUT_FILE, JSON.stringify(state, null, 2));
}

if (Object.keys(state.wallets).length === 0) {
  for (const wp of walletPlans) {
    state.wallets[wp.name] = [
      ...wp.sells.map((p, i) => ({ side: "sell" as const, slot: i, price: p.price.toString(), qty: p.testaAmount.toString() })),
      ...wp.buys.map((p, i) => ({ side: "buy" as const, slot: i, price: p.price.toString(), qty: p.testaAmount.toString() })),
    ];
  }
  save();
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
    (u) => u.output.amount.length === 1 && u.output.amount[0]!.unit === "lovelace" && BigInt(u.output.amount[0]!.quantity) >= min
  );
}

async function walletCtx(w: MeshWallet): Promise<WalletContext> {
  const changeAddress = await w.getChangeAddress();
  const utxos = (await w.getUtxos()) as UTxO[];
  const collateral = findPureAdaUtxo(utxos, 5_000_000n);
  return { changeAddress, utxos, ...(collateral ? { collateral } : {}) };
}

// ------------------------------------------------------------- funding ADA

if (!state.fundingAda?.done) {
  console.log(`\nFunding step: ADA top-up for all ${N} wallets…`);
  const tx = new Transaction({ initiator: walletA });
  for (const addr of mmAddrs) {
    tx.sendLovelace(addr, (22_000_000n).toString());
  }
  const unsigned = await tx.build();
  const txHash = await signAndSubmit(walletA, unsigned);
  state.fundingAda = { done: false, txHash };
  save();
  await waitForTx(txHash, "funding-ADA");
  await waitForWalletToSee(walletA, txHash, "wallet-a funding-ADA change");
  state.fundingAda.done = true;
  save();
} else {
  console.log(`\nFunding-ADA already done (tx ${state.fundingAda.txHash}).`);
}

// ------------------------------------------------------------ funding TESTA

if (!state.fundingTesta?.done) {
  console.log(`\nFunding step: TESTA for all ${N} wallets' sell orders…`);
  const tx = new Transaction({ initiator: walletA });
  for (let i = 0; i < N; i++) {
    const wp = walletPlans[i]!;
    const testaTotal = wp.sells.reduce((s, p) => s + p.testaAmount, 0n);
    const assets: Asset[] = [
      { unit: "lovelace", quantity: MIN_ASSET_UTXO.toString() },
      { unit: TESTA.replace(".", ""), quantity: testaTotal.toString() },
    ];
    tx.sendAssets(mmAddrs[i]!, assets);
  }
  const unsigned = await tx.build();
  const txHash = await signAndSubmit(walletA, unsigned);
  state.fundingTesta = { done: false, txHash };
  save();
  await waitForTx(txHash, "funding-TESTA");
  await waitForWalletToSee(walletA, txHash, "wallet-a funding-TESTA change");
  state.fundingTesta.done = true;
  save();
} else {
  console.log(`Funding-TESTA already done (tx ${state.fundingTesta.txHash}).`);
}

// ------------------------------------------------------- round-robin orders
//
// 4 rounds: [sell#0, sell#1, buy#0, buy#1]. Each round submits for every
// wallet, then waits for ALL of that round's txs to confirm before the next
// round (a wallet's own txs must be sequential; different wallets don't need
// to wait on each other, so batching by round is the fast path).

type Round = { side: "sell" | "buy"; slot: number };
const rounds: Round[] = [
  { side: "sell", slot: 0 },
  { side: "sell", slot: 1 },
  { side: "buy", slot: 0 },
  { side: "buy", slot: 1 },
];

for (const round of rounds) {
  console.log(`\n=== Round: ${round.side} #${round.slot} ===`);
  const pending: { name: string; w: MeshWallet; txHash: string }[] = [];

  for (let i = 0; i < N; i++) {
    const name = mmNames[i]!;
    const w = mmWallets[i]!;
    const rec = state.wallets[name]!.find((r) => r.side === round.side && r.slot === round.slot)!;
    if (rec.txHash) {
      console.log(`  ${name} ${round.side}#${round.slot}: already submitted (${rec.txHash}) — confirming visibility`);
      await waitForTx(rec.txHash, `${name} ${round.side}#${round.slot}`);
      await waitForWalletToSee(w, rec.txHash, `${name} ${round.side}#${round.slot}`);
      continue;
    }
    const price = BigInt(rec.price);
    const qty = BigInt(rec.qty);
    const offerAsset = round.side === "sell" ? TESTA : "lovelace";
    const askAsset = round.side === "sell" ? "lovelace" : TESTA;
    const offerAmount = round.side === "sell" ? qty : price * qty;
    const askAmount = round.side === "sell" ? price * qty : qty;

    const build = await txBuilder.buildCreateOrder({
      wallet: await walletCtx(w),
      offerAsset,
      offerAmount,
      askAsset,
      askAmount,
    });
    const txHash = await signAndSubmit(w, build.unsignedTxCborHex);
    rec.txHash = txHash;
    save();
    console.log(`  ${name} ${round.side}#${round.slot}: submitted ${txHash} (price ${price}, qty ${qty})`);
    pending.push({ name, w, txHash });
  }

  console.log(`  waiting for ${pending.length} tx(es) in this round to confirm and be visible…`);
  for (const { name, w, txHash } of pending) {
    await waitForTx(txHash, `${name} ${round.side}#${round.slot}`);
    await waitForWalletToSee(w, txHash, `${name} ${round.side}#${round.slot}`);
  }
}

// ------------------------------------------------------------- resolve ids

console.log(`\nResolving order ids…`);
for (const name of mmNames) {
  for (const rec of state.wallets[name]!) {
    if (rec.orderId || !rec.txHash) continue;
    const tx = await provider.getTxUtxos(rec.txHash);
    const idx = tx!.outputs.findIndex((o) => o.amount.some((a) => a.unit.startsWith(scripts.beaconPolicyId)));
    if (idx < 0) throw new Error(`order output not found in tx ${rec.txHash}`);
    rec.orderId = `${rec.txHash}#${idx}`;
    console.log(`  ${name} ${rec.side}#${rec.slot}: ${rec.orderId}`);
  }
}
save();

const total = Object.values(state.wallets).flat().length;
const done = Object.values(state.wallets)
  .flat()
  .filter((r) => r.orderId).length;
console.log(`\nDone — ${done}/${total} orders on-chain across ${N} wallets.`);
console.log(`Details saved to ${OUT_FILE}.`);
