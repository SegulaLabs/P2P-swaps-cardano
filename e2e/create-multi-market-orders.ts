/**
 * Builds 10 order books on protocol v3:
 *   5 token/ADA markets  : TESTB,TESTC,TESTD,TESTE,TESTF each vs lovelace
 *   5 token/token markets: a ring — TESTB/TESTC, TESTC/TESTD, TESTD/TESTE,
 *                           TESTE/TESTF, TESTF/TESTB
 * Each market gets 20 orders (10 sell + 10 buy) = 200 orders total.
 *
 * All prices are >= 1 (quote per base), matching the "1000 tokens for 1000
 * ada, 500 for 600 ada" convention — never a fractional sub-1 ratio.
 *
 * New tokens: minted under the SAME single-signature policy as TESTA
 * (ForgeScript.withOneSignature(wallet-a-seller)) — just new asset names
 * under it, exactly how TESTA itself was minted.
 *
 * Wallets: reuses the 20 existing mm-* wallets. Market i (0-9) gets a
 * dedicated pair: seller = mm-(2i) does all 10 sell orders (offer X, ask Y),
 * buyer = mm-(2i+1) does all 10 buy orders (offer Y, ask X). This means
 * each wallet only ever needs ONE asset type beyond ADA, which keeps
 * funding simple.
 *
 * Also sends 1000 of each new token (TESTB..TESTF) to the user-supplied
 * Eternl address in one combined multi-asset output.
 *
 * Phases (each waits for confirmation + wallet-visibility before the next,
 * per the Blockfrost UTxO-list-lag lesson from the v2/v3 runs):
 *   1. mint 3000 of each of the 5 new tokens to wallet-a-seller
 *   2. fund ADA (pure-lovelace, role-sized) to all 20 mm wallets
 *   3. fund tokens (token + min-ada) to the 15 wallets that need one,
 *      plus the combined 5-token gift to the Eternl address
 *   4. 10-round round-robin: round r submits order slot r for all 20
 *      wallets, waits for the round to confirm before round r+1
 *
 * Idempotent-ish: progress written to create-multi-market-orders.out.json.
 */
import { ForgeScript, MeshWallet, resolveScriptHash, stringToHex, Transaction, type Asset, type UTxO } from "@meshsdk/core";
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

const OUT_FILE = join(HERE, "create-multi-market-orders.out.json");
const MM_DIR = join(HERE, "wallets", "mm");
const ETERNL_ADDR =
  "addr_test1qp7skm75gqj3hsk52jgxfufd4znf3ccmycdj0llyu38wqjgkfedku5jmmz0amt8jnpv7qu40m39mx54jhh7x3vh3tsaskhhmcd";

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
const addrA = walletA.addresses.baseAddressBech32!;

const forgeScript = ForgeScript.withOneSignature(addrA);
const testPolicy = resolveScriptHash(forgeScript);
const TOKEN_NAMES = ["TESTB", "TESTC", "TESTD", "TESTE", "TESTF"] as const;
type TokenName = (typeof TOKEN_NAMES)[number];
const unitOf = (name: TokenName) => `${testPolicy}${stringToHex(name)}`; // mesh "unit" (no dot)
const assetIdOf = (name: TokenName) => `${testPolicy}.${stringToHex(name)}`; // buildCreateOrder "offerAsset" (with dot)
const MINT_QTY = 3000n;
const USER_GIFT_QTY = 1000n;

const mmNames = readdirSync(MM_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(".json", ""))
  .sort((a, b) => parseInt(a.match(/\d+/)![0]!, 10) - parseInt(b.match(/\d+/)![0]!, 10));
if (mmNames.length !== 20) throw new Error(`expected 20 mm wallets, found ${mmNames.length}`);
const mmWallets = mmNames.map((n) => loadWallet("mm", n));
for (const w of mmWallets) await w.init();
const mmAddrs = mmWallets.map((w) => w.addresses.baseAddressBech32!);

// ------------------------------------------------------------- market plan

type Asset_ = { kind: "ada" } | { kind: "token"; name: TokenName };
type Market = { label: string; x: Asset_; y: Asset_ };

const markets: Market[] = [
  ...TOKEN_NAMES.map((name) => ({ label: `${name}/ADA`, x: { kind: "token" as const, name }, y: { kind: "ada" as const } })),
  { label: "TESTB/TESTC", x: { kind: "token", name: "TESTB" }, y: { kind: "token", name: "TESTC" } },
  { label: "TESTC/TESTD", x: { kind: "token", name: "TESTC" }, y: { kind: "token", name: "TESTD" } },
  { label: "TESTD/TESTE", x: { kind: "token", name: "TESTD" }, y: { kind: "token", name: "TESTE" } },
  { label: "TESTE/TESTF", x: { kind: "token", name: "TESTE" }, y: { kind: "token", name: "TESTF" } },
  { label: "TESTF/TESTB", x: { kind: "token", name: "TESTF" }, y: { kind: "token", name: "TESTB" } },
];
if (markets.length !== 10) throw new Error("expected exactly 10 markets");

function assetIdFor(a: Asset_): string {
  return a.kind === "ada" ? "lovelace" : assetIdOf(a.name);
}
function unitFor(a: Asset_): string {
  return a.kind === "ada" ? "lovelace" : unitOf(a.name);
}

// price/qty ladders — always ratio >= 1 (ask/offer, quote per base)
const sellQtyAt = (k: number) => BigInt(20 + 5 * k); // 20..65 — X offered by the seller
const priceAt = (k: number) => BigInt(1 + k); // 1..10 ADA-or-token per base unit
const buyQtyAt = (k: number) => BigInt(1 + (k % 5)); // 1..5 — X asked by the buyer (bounds the buyer's outlay)

type OrderRecord = { side: "sell" | "buy"; slot: number; price: string; qty: string; txHash?: string; orderId?: string };
type WalletRole = { name: string; role: "seller" | "buyer"; market: number };

const walletRoles: WalletRole[] = [];
for (let i = 0; i < 10; i++) {
  walletRoles.push({ name: mmNames[2 * i]!, role: "seller", market: i });
  walletRoles.push({ name: mmNames[2 * i + 1]!, role: "buyer", market: i });
}

console.log(`\n10 markets:`);
markets.forEach((m, i) => console.log(`  M${i}: ${m.label}  seller=${mmNames[2 * i]}  buyer=${mmNames[2 * i + 1]}`));

// ------------------------------------------------------------------ resume

type State = {
  mint?: { done: boolean; txHash?: string };
  fundingAda?: { done: boolean; txHash?: string };
  fundingTokens?: { done: boolean; txHash?: string };
  wallets: Record<string, OrderRecord[]>;
};
const state: State = existsSync(OUT_FILE) ? (JSON.parse(readFileSync(OUT_FILE, "utf8")) as State) : { wallets: {} };
function save() {
  writeFileSync(OUT_FILE, JSON.stringify(state, null, 2));
}

if (Object.keys(state.wallets).length === 0) {
  for (const wr of walletRoles) {
    const recs: OrderRecord[] = [];
    for (let k = 0; k < 10; k++) {
      if (wr.role === "seller") recs.push({ side: "sell", slot: k, price: priceAt(k).toString(), qty: sellQtyAt(k).toString() });
      else recs.push({ side: "buy", slot: k, price: priceAt(k).toString(), qty: buyQtyAt(k).toString() });
    }
    state.wallets[wr.name] = recs;
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

// ------------------------------------------------------------------ mint

if (!state.mint?.done) {
  console.log(`\nMinting ${MINT_QTY} of each of ${TOKEN_NAMES.join(", ")} to wallet-a-seller…`);
  const tx = new Transaction({ initiator: walletA });
  for (const name of TOKEN_NAMES) {
    tx.mintAsset(forgeScript, { assetName: name, assetQuantity: MINT_QTY.toString(), recipient: addrA });
  }
  const unsigned = await tx.build();
  const txHash = await signAndSubmit(walletA, unsigned);
  state.mint = { done: false, txHash };
  save();
  await waitForTx(txHash, "mint");
  await waitForWalletToSee(walletA, txHash, "wallet-a mint");
  state.mint.done = true;
  save();
} else {
  console.log(`\nMint already done (tx ${state.mint.txHash}).`);
}

// ------------------------------------------------------------- funding ADA

function walletAdaTarget(wr: WalletRole): bigint {
  const m = markets[wr.market]!;
  if (wr.role === "seller") return 90_000_000n; // baseline (10x deposit+margin) + buffer
  // buyer
  if (m.y.kind === "ada") return 300_000_000n; // baseline + offer-side ADA outlay
  return 90_000_000n; // cross-market buyer only needs baseline (its outlay is the OTHER token)
}

if (!state.fundingAda?.done) {
  console.log(`\nFunding step: ADA (role-sized) for all 20 wallets…`);
  const tx = new Transaction({ initiator: walletA });
  let total = 0n;
  for (const wr of walletRoles) {
    const amt = walletAdaTarget(wr);
    total += amt;
    const addr = mmAddrs[mmNames.indexOf(wr.name)]!;
    tx.sendLovelace(addr, amt.toString());
  }
  console.log(`  total ADA: ${Number(total) / 1e6}`);
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

// ---------------------------------------------------------- funding tokens

if (!state.fundingTokens?.done) {
  console.log(`\nFunding step: tokens for sellers/cross-buyers + Eternl gift…`);
  const tx = new Transaction({ initiator: walletA });
  const MIN_ASSET_UTXO = 1_500_000n;

  for (const wr of walletRoles) {
    const m = markets[wr.market]!;
    const asset = wr.role === "seller" ? m.x : m.y;
    if (asset.kind !== "token") continue; // ada-market buyer: nothing to send here
    const qty = wr.role === "seller" ? 450n : 200n;
    const addr = mmAddrs[mmNames.indexOf(wr.name)]!;
    const assets: Asset[] = [
      { unit: "lovelace", quantity: MIN_ASSET_UTXO.toString() },
      { unit: unitOf(asset.name), quantity: qty.toString() },
    ];
    tx.sendAssets(addr, assets);
  }

  const giftAssets: Asset[] = [
    { unit: "lovelace", quantity: "10000000" },
    ...TOKEN_NAMES.map((name) => ({ unit: unitOf(name), quantity: USER_GIFT_QTY.toString() })),
  ];
  tx.sendAssets(ETERNL_ADDR, giftAssets);

  const unsigned = await tx.build();
  const txHash = await signAndSubmit(walletA, unsigned);
  state.fundingTokens = { done: false, txHash };
  save();
  await waitForTx(txHash, "funding-tokens");
  await waitForWalletToSee(walletA, txHash, "wallet-a funding-tokens change");
  state.fundingTokens.done = true;
  save();
} else {
  console.log(`Funding-tokens already done (tx ${state.fundingTokens.txHash}).`);
}

// ------------------------------------------------------- round-robin orders

for (let slot = 0; slot < 10; slot++) {
  console.log(`\n=== Round: slot #${slot} ===`);
  const pending: { name: string; w: MeshWallet; txHash: string }[] = [];

  for (const wr of walletRoles) {
    const i = mmNames.indexOf(wr.name);
    const w = mmWallets[i]!;
    const m = markets[wr.market]!;
    const rec = state.wallets[wr.name]!.find((r) => r.slot === slot)!;

    if (rec.txHash) {
      console.log(`  ${wr.name} M${wr.market} ${rec.side}#${slot}: already submitted (${rec.txHash}) — confirming visibility`);
      await waitForTx(rec.txHash, `${wr.name} slot#${slot}`);
      await waitForWalletToSee(w, rec.txHash, `${wr.name} slot#${slot}`);
      continue;
    }

    const price = BigInt(rec.price);
    const qty = BigInt(rec.qty);
    const scale = (a: Asset_, amount: bigint) => (a.kind === "ada" ? amount * 1_000_000n : amount);

    let offerAsset: string, askAsset: string, offerAmount: bigint, askAmount: bigint;
    if (rec.side === "sell") {
      offerAsset = assetIdFor(m.x);
      askAsset = assetIdFor(m.y);
      offerAmount = qty; // X is never ADA in these markets except... X is only a token here (ada markets have y=ada)
      askAmount = scale(m.y, qty * price);
    } else {
      offerAsset = assetIdFor(m.y);
      askAsset = assetIdFor(m.x);
      offerAmount = scale(m.y, qty * price);
      askAmount = qty;
    }

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
    console.log(`  ${wr.name} M${wr.market} (${m.label}) ${rec.side}#${slot}: submitted ${txHash} (price ${price}, qty ${qty})`);
    pending.push({ name: wr.name, w, txHash });
  }

  console.log(`  waiting for ${pending.length} tx(es) in this round…`);
  for (const { name, w, txHash } of pending) {
    await waitForTx(txHash, `${name} slot#${slot}`);
    await waitForWalletToSee(w, txHash, `${name} slot#${slot}`);
  }
}

// ------------------------------------------------------------- resolve ids

console.log(`\nResolving order ids…`);
for (const wr of walletRoles) {
  for (const rec of state.wallets[wr.name]!) {
    if (rec.orderId || !rec.txHash) continue;
    const tx = await provider.getTxUtxos(rec.txHash);
    const idx = tx!.outputs.findIndex((o) => o.amount.some((a) => a.unit.startsWith(scripts.beaconPolicyId)));
    if (idx < 0) throw new Error(`order output not found in tx ${rec.txHash}`);
    rec.orderId = `${rec.txHash}#${idx}`;
  }
}
save();

const total = Object.values(state.wallets).flat().length;
const done = Object.values(state.wallets).flat().filter((r) => r.orderId).length;
console.log(`\nDone — ${done}/${total} orders on-chain across 10 markets / 20 wallets.`);
console.log(`Eternl gift address: ${ETERNL_ADDR} — ${USER_GIFT_QTY} of each of ${TOKEN_NAMES.join(", ")}`);
console.log(`Details saved to ${OUT_FILE}.`);
