/**
 * Generate the two throwaway PREPROD test wallets (idempotent: never
 * overwrites existing wallets). Prints the base addresses to fund from the
 * faucet: https://docs.cardano.org/cardano-testnets/tools/faucet
 */
import { MeshWallet } from "@meshsdk/core";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WALLETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "wallets");
mkdirSync(WALLETS_DIR, { recursive: true });

async function loadOrCreate(name: string): Promise<{ name: string; address: string }> {
  const file = join(WALLETS_DIR, `${name}.json`);
  let words: string[];
  if (existsSync(file)) {
    words = (JSON.parse(readFileSync(file, "utf8")) as { mnemonic: string[] }).mnemonic;
  } else {
    words = MeshWallet.brew() as string[];
    writeFileSync(
      file,
      JSON.stringify(
        { network: "preprod", purpose: "throwaway e2e test wallet — never reuse", mnemonic: words },
        null,
        2
      )
    );
    chmodSync(file, 0o600);
  }
  const wallet = new MeshWallet({ networkId: 0, key: { type: "mnemonic", words } });
  await wallet.init();
  const address = wallet.addresses.baseAddressBech32;
  if (!address) throw new Error(`${name}: no base address derived`);
  return { name, address };
}

const a = await loadOrCreate("wallet-a-seller");
const b = await loadOrCreate("wallet-b-taker");

console.log("\nPreprod test wallets (throwaway — faucet funds only):\n");
console.log(`  ${a.name}:\n  ${a.address}\n`);
console.log(`  ${b.name}:\n  ${b.address}\n`);
console.log("Fund BOTH at https://docs.cardano.org/cardano-testnets/tools/faucet");
console.log("then run: npx tsx e2e/smoke.ts");
