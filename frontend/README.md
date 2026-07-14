# Frontend (Next.js)

UI for the P2P beacon DEX. **Preprod only**; the badge in the header is
rendered from env and screams if misconfigured.

## Pages

- `/` — swap-style `TradePanel`: sell from wallet tokens, buy from market
  tokens; the backend's smart-fill route is shown leg by leg (partial legs
  marked `◐`) before you sign. Create mode opts an order into partial fills.
- `/trade/[pair]` — order book with token names/avatars, Take flow
- `/orders` — MyOrders (cancel; Update postponed) + TxHistory
- `/arbitrage` — `ArbitragePanel`: profitable cycles over the open book,
  settled as one atomic batched take

## Components

`WalletConnect` (custom connect drawer over `useWalletList`) + `WalletModalContext`,
`TradePanel` (trade + create, with `PercentSlider` and the "allow partial fills"
toggle) and `TokenSelect` (modal picker: wallet balances on the sell side,
market assets on the buy side, paste-an-id escape hatch),
`Token` (TokenAvatar/TokenTicker/TokenAmount — names via GET /assets/:id with
ASCII fallback, decimals cosmetic only), `OrderBook`, `MarketsSidebar`,
`MyOrders`, `TxHistory`, `ArbitragePanel`,
`TransactionPreview` (security-critical; shows human AND raw amounts),
`TxStatus`, `NetworkBadge`, `PairTitle`, `ExplorerLink`, `Callout`.
Hooks: `useTxFlow` (build → preview → sign → submit → poll), `useAssetInfo`,
`useMarketAssets`, `useWalletBalances`, `useOwnerCredential`,
`useInstalledWallets`.

## Signing flow

1. Backend `POST /tx/*` returns an **unsigned** tx (CBOR hex) + summary.
2. `TransactionPreview` shows the summary, all warnings, and the raw CBOR —
   and states plainly that independent client-side decoding is not
   implemented yet (open-questions #27); the wallet's display is the second
   check.
3. User explicitly confirms → CIP-30 `signTx(hex, partialSign=true)` in the
   browser wallet → wallet submits.
4. `TxStatus` polls confirmations until the indexer reflects the change;
   takes can race (two people, one UTxO) — the loser's tx fails harmlessly
   and the book is refetched.

## ⚠ F-01 — the preview is not yet trustless (High)

The adversarial audit
([Audit/security-audit-fable5.md](../Audit/security-audit-fable5.md)) found the
contracts sound but flagged **this app** as the material risk: we sign
backend-provided CBOR while showing a **backend-provided summary** — only the
*fee* is decoded from the real transaction. A malicious or compromised backend
(or a MITM on an un-pinned connection) can present a benign preview while the
real transaction routes **the signer's own** funds elsewhere. The on-chain
validators protect the *seller's* payment; they do not protect the party who
authors and signs the tx.

Closing this — decoding the CBOR client-side and diffing it against the
displayed summary — is the single highest-value piece of work here and gates
any use beyond preprod. Until then the wallet's own display is the only
independent check.

## Status

**Implemented — protocol v3.** 66 vitest tests, typecheck and `next build`
green. Wallet layer is Mesh React (`@meshsdk/react` 2.0 beta —
open-questions #26): connect via the custom picker, flows run
build → TransactionPreview (explicit confirm, warnings never hidden, tested to
never auto-sign) → `signTx` → submit → TxStatus polling. Takes route through
smart-fill and settle as one atomic batch (v2), including v3 partial legs.
UpdateOrder has no UI surface (postponed).

```bash
cp .env.example .env.local
npm install
npm run dev   # :3000
```
