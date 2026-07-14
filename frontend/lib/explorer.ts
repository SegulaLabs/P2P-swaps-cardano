/**
 * Cardanoscan link helper. Follows NEXT_PUBLIC_CARDANO_NETWORK so links
 * always point at the right explorer: preprod.cardanoscan.io on preprod,
 * cardanoscan.io once/if this ever runs on mainnet.
 */
const network = process.env.NEXT_PUBLIC_CARDANO_NETWORK ?? "preprod";
const EXPLORER_BASE =
  network === "mainnet"
    ? "https://cardanoscan.io"
    : "https://preprod.cardanoscan.io";

export function explorerTxUrl(txHash: string): string {
  return `${EXPLORER_BASE}/transaction/${txHash}`;
}
