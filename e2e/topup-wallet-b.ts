/** One-off: send 100 tADA from throwaway wallet A to wallet B so B can fund
 *  its seed-order deposits (B's v1 deposits are locked on the old contract). */
import { MeshWallet, Transaction } from "@meshsdk/core";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const HERE = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: join(HERE, "..", "backend", ".env") });

import { parseEnv } from "../backend/src/config.js";
import { BlockfrostChainProvider } from "../backend/src/services/chain-provider.js";

const cfg = parseEnv(process.env);
const provider = new BlockfrostChainProvider(cfg.BLOCKFROST_PROJECT_ID_PREPROD);

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
const addrB = walletB.addresses.baseAddressBech32!;

const tx = new Transaction({ initiator: walletA });
tx.sendLovelace(addrB, "100000000"); // 100 tADA
const unsigned = await tx.build();
const signed = await walletA.signTx(unsigned, true);
const hash = await walletA.submitTx(signed);
console.log(`top-up tx: ${hash}`);
for (let i = 0; i < 60; i++) {
  const conf = await provider.getTxConfirmations(hash);
  if (conf !== null && conf >= 1) {
    console.log(`confirmed (${conf})`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
console.error("not confirmed after 10 minutes");
process.exit(1);
