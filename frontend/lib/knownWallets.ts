/** Common CIP-30 wallets, keyed by their window.cardano injection key. */
export interface KnownWallet {
  id: string;
  name: string;
  installUrl: string;
}

export const KNOWN_WALLETS: KnownWallet[] = [
  { id: "eternl", name: "Eternl", installUrl: "https://eternl.io/" },
  { id: "lace", name: "Lace", installUrl: "https://www.lace.io/" },
  { id: "nami", name: "Nami", installUrl: "https://namiwallet.io/" },
  { id: "flint", name: "Flint", installUrl: "https://flint-wallet.com/" },
  { id: "typhoncip30", name: "Typhon", installUrl: "https://typhonwallet.io/" },
  { id: "vespr", name: "Vespr", installUrl: "https://vespr.xyz/" },
  { id: "begin", name: "Begin", installUrl: "https://begin.is/" },
  { id: "yoroi", name: "Yoroi", installUrl: "https://yoroi-wallet.com/" },
];
