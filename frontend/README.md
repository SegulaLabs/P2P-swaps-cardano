# Frontend (Next.js)

UI for the P2P beacon DEX. **Preprod only**; the badge in the header is
rendered from env and screams if misconfigured.

## Pages

- `/` — Jupiter-style swap card (SwapCreateForm: sell from wallet tokens,
  buy from market tokens) + live markets grid
- `/trade/[pair]` — order book with token names/avatars, Take flow
- `/orders` — MyOrders (cancel; Update postponed)

## Components

`WalletConnect` (custom connect drawer over `useWalletList`),
`SwapCreateForm` + `TokenSelect` (modal picker: wallet balances on the sell
side, market assets on the buy side, paste-an-id escape hatch),
`Token` (TokenAvatar/TokenTicker/TokenAmount — names via GET /assets/:id with
ASCII fallback, decimals cosmetic only), `OrderBook`, `MyOrders`,
`TransactionPreview` (security-critical; shows human AND raw amounts),
`TxStatus`, `NetworkBadge`, `PairTitle`.

## Signing flow (once implemented)

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

## Status

**Implemented** — 19 vitest tests, typecheck and `next build` green. Wallet
layer is Mesh React (`@meshsdk/react` 2.0 beta — open-questions #26): connect
via the CardanoWallet picker, flows run build → TransactionPreview (explicit
confirm, warnings never hidden, tested to never auto-sign) → `signTx` →
submit → TxStatus polling. UpdateOrder has no UI surface (postponed).
Remaining trust gap: the preview renders the backend summary; client-side
CBOR decoding is #27.

```bash
cp .env.example .env.local
npm install
npm run dev   # :3000
```
