/**
 * Gives each of the 20 mm-* wallets a 2-sell + 2-buy TESTA/lovelace order
 * set under the CURRENT protocol v3 contract, with allowPartialFill=true so
 * the new partial-fill / continuation-output feature has real orders to
 * exercise (docs/partial-fills.md).
 *
 * Price range: 1 -> 100 ADA per TESTA, whole-ADA increments (not fractional
 * lovelace/TESTA like the earlier v2 batch) so a taker deals in round ADA
 * amounts when partially filling.
 *
 * Note: the v2 orders created earlier (create-mm-v2-variety-orders.ts) are
 * now stranded — v3 has a new beacon policy id, so the current indexer does
 * not see them. This script targets v3 only.
 *
 * Funding: wallet-a-seller funds both ADA (per-wallet, sized exactly to
 * that wallet's 4 planned orders + margin) and TESTA (for the 2 sell
 * orders) in two multi-output txs. Then the same 4-round round-robin
 * pattern as create-mm-v2-variety-orders.ts: round r submits order slot r
 * for all 20 wallets, waits for confirmation AND wallet-visibility (Blockfrost's
 * UTxO-list endpoint lags its confirmations endpoint — see prior run) before
 * the next round.
 *
 * Idempotent-ish: progress written to create-mm-v3-partial-orders.out.json.
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

const OUT_FILE = join(HERE, "create-mm-v3-partial-orders.out.json");
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

const N = mmWallets.length;
const SLOT_COUNT = N * 2; // 2 sell + 2 buy per wallet

// Whole-ADA price ladder, 1 -> 100 ADA/TESTA, linspace over SLOT_COUNT.
const priceAt = (k: number) => BigInt(Math.round(1 + (k * (100 - 1)) / (SLOT_COUNT - 1)));
const sellQtyAt = (k: number) => BigInt(5 + (k % 8)); // 5..12 TESTA — enough to leave room for a partial take
const buyQtyAt = (k: number) => BigInt(1 + (k % 3)); // 1..3 TESTA — keeps buy-order ADA cost bounded at high prices

type OrderPlan = { side: "sell" | "buy"; price: bigint; testaAmount: bigint };
type WalletPlan = { name: string; sells: OrderPlan[]; buys: OrderPlan[] };

const walletPlans: WalletPlan[] = mmNames.map((name, i) => ({
  name,
  sells: [0, 1].map((j) => {
    const k = i * 2 + j;
    return { side: "sell" as const, price: priceAt(k), testaAmount: sellQtyAt(k) };
  }),
  buys: [0, 1].map((j) => {
    const k = i * 2 + j;
    return { side: "buy" as const, price: priceAt(k), testaAmount: buyQtyAt(k) };
  }),
}));

console.log(`\nPlan: ${N} wallets x (2 sell + 2 buy) = ${N * 4} orders, allowPartialFill=true, price 1-100 ADA/TESTA`);
for (const wp of walletPlans.slice(0, 3)) {
  console.log(
    `  ${wp.name}: sell ${wp.sells.map((p) => `${p.testaAmount}@${p.price}ADA`).join(", ")} | ` +
      `buy ${wp.buys.map((p) => `${p.testaAmount}@${p.price}ADA`).join(", ")}`
  );
}
console.log(`  … (${N - 3} more)`);

const DEPOSIT = 3_500_000n;
const PER_ORDER_MARGIN = 3_000_000n; // fee + min-change safety per tx (learned the hard way on the v2 run)
const MIN_ASSET_UTXO = 1_500_000n;

function walletMainAdaNeeded(wp: WalletPlan): bigint {
  const sellLock = BigInt(wp.sells.length) * DEPOSIT;
  const buyLock = wp.buys.reduce((s, p) => s + p.price * 1_000_000n * p.testaAmount + DEPOSIT, 0n);
  const margin = BigInt(wp.sells.length + wp.buys.length) * PER_ORDER_MARGIN;
  return sellLock + buyLock + margin;
}

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
  console.log(`\nFunding step: ADA top-up (per-wallet sized) for all ${N} wallets…`);
  const tx = new Transaction({ initiator: walletA });
  let grandTotal = 0n;
  for (let i = 0; i < N; i++) {
    const need = walletMainAdaNeeded(walletPlans[i]!);
    grandTotal += need;
    tx.sendLovelace(mmAddrs[i]!, need.toString());
  }
  console.log(`  total ADA to send: ${Number(grandTotal) / 1e6} ADA`);
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
    const offerAmount = round.side === "sell" ? qty : price * 1_000_000n * qty;
    const askAmount = round.side === "sell" ? price * 1_000_000n * qty : qty;

    const build = await txBuilder.buildCreateOrder({
      wallet: await walletCtx(w),
      offerAsset,
      offerAmount,
      askAsset,
      askAmount,
      allowPartialFill: true,
    });
    const txHash = await signAndSubmit(w, build.unsignedTxCborHex);
    rec.txHash = txHash;
    save();
    console.log(`  ${name} ${round.side}#${round.slot}: submitted ${txHash} (price ${price} ADA, qty ${qty})`);
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
console.log(`\nDone — ${done}/${total} orders on-chain across ${N} wallets (protocol v3, allowPartialFill=true).`);
console.log(`Details saved to ${OUT_FILE}.`);
