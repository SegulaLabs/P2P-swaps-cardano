import {
  MeshTxBuilder,
  deserializeAddress,
  pubKeyAddress,
  serializeAddressObj,
  unixTimeToEnclosingSlot,
  SLOT_CONFIG_NETWORK,
  type UTxO,
  type Asset,
} from "@meshsdk/core";
import type { ChainProvider } from "./chain-provider.js";
import type { ProtocolScripts } from "../protocol/blueprint.js";
import {
  type AssetClassHex,
  deriveBeaconNames,
  fromApiAssetId,
  isAda,
  toApiAssetId,
  toPairId,
} from "../protocol/beacons.js";
import {
  encodeOrderDatum,
  encodePaymentTag,
  decodeOrderDatum,
  requiredPayment,
  takePartialRedeemer,
  type OrderDatumFields,
  CANCEL_REDEEMER,
  TAKE_REDEEMER,
  MINT_BEACONS_REDEEMER,
  BURN_BEACONS_REDEEMER,
} from "../protocol/datum.js";
import type {
  PartialFillSummary,
  TxSummary,
  UnsignedTxResponse,
} from "../types.js";

/**
 * Unsigned-transaction builder (Mesh). NON-NEGOTIABLE INVARIANTS
 * (docs/security.md): no signing, no keys, coin selection only from the
 * requesting wallet's own UTxOs, collateral only from the wallet, and order
 * state is re-fetched from the chain at build time — the DB cache is never
 * trusted for fund-touching operations.
 */

export class BuildError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "order_not_found"
      | "order_expired"
      | "not_an_order"
      | "provider_unavailable"
      | "insufficient_funds",
    message: string
  ) {
    super(message);
  }
}

export interface WalletContext {
  /** Bech32 change address of the connected wallet (also the fee payer). */
  changeAddress: string;
  /** The wallet's UTxOs (Mesh UTxO JSON from CIP-30 via @meshsdk/wallet). */
  utxos: UTxO[];
  /** A collateral UTxO from the wallet — required for script transactions. */
  collateral?: UTxO;
}

/** The exact four failure strings @cardano-sdk/input-selection throws
 *  (ts-custom-error's message IS the enum value — see InputSelectionFailure
 *  in @cardano-sdk/input-selection, a transitive dep we don't import
 *  directly to avoid depending on an undeclared package). */
const INPUT_SELECTION_FAILURES = [
  "UTxO Balance Insufficient",
  "UTxO Not Fragmented Enough",
  "UTxO Fully Depleted",
  "Maximum Input Count Exceeded",
];

/**
 * Turn Mesh/cardano-sdk's bare coin-selection failure into a diagnostic
 * BuildError with actual numbers, or null if `message` isn't one of those
 * failures (caller should rethrow the original error unchanged).
 *
 * That total is the CALLER-SUPPLIED wallet context, not something we
 * independently verify — so on failure, report exactly what we received.
 * That's the fastest way to tell apart the two real causes of "insufficient"
 * despite a healthy-looking wallet: (a) the wallet extension only exposed a
 * PARTIAL UTxO set to this dApp (some wallets cap what a single getUtxos()
 * call returns once an address has accumulated many small UTxOs — plausible
 * here, since this protocol returns a 3.5 ADA deposit UTxO on every
 * cancel/take), or (b) the order's ask is a specific token the wallet is
 * actually short on, which "I have plenty of ADA" doesn't rule out.
 */
export function describeInsufficientFunds(
  message: string,
  wallet: WalletContext
): BuildError | null {
  if (!INPUT_SELECTION_FAILURES.some((k) => message.includes(k))) return null;

  const collateral = wallet.collateral;
  const spendable = collateral
    ? wallet.utxos.filter(
        (u) =>
          u.input.txHash !== collateral.input.txHash ||
          u.input.outputIndex !== collateral.input.outputIndex
      )
    : wallet.utxos;
  const totals = new Map<string, bigint>();
  for (const u of spendable)
    for (const a of u.output.amount)
      totals.set(a.unit, (totals.get(a.unit) ?? 0n) + BigInt(a.quantity));
  const lovelace = totals.get("lovelace") ?? 0n;
  const otherAssets = [...totals.entries()]
    .filter(([unit]) => unit !== "lovelace")
    .slice(0, 5)
    .map(([unit, qty]) => `${qty} of ${unit}`)
    .join(", ");

  return new BuildError(
    "insufficient_funds",
    `Your wallet's UTxO set (as submitted to this dApp) couldn't cover this ` +
      `transaction — cardano-sdk reported "${message}". The backend received ` +
      `${spendable.length} spendable UTxO(s) totaling ${lovelace} lovelace` +
      `${otherAssets ? ` and ${otherAssets}` : ""} (excluding collateral). ` +
      `If that's lower than your wallet's real balance, your wallet extension ` +
      `likely only returned a PARTIAL UTxO set for this request (common once a ` +
      `wallet has accumulated many small UTxOs, e.g. deposit refunds) — try ` +
      `consolidating UTxOs in your wallet or reconnecting it. If the total above ` +
      `does match your balance, check that this order's ask asset (not ` +
      `necessarily ADA) is one you actually hold enough of.`
  );
}

export interface CreateOrderParams {
  wallet: WalletContext;
  /** Defaults to the wallet's change address. Must be a key address. */
  paymentAddress?: string;
  offerAsset: string; // API asset id
  offerAmount: bigint;
  askAsset: string;
  askAmount: bigint;
  /** POSIX ms */
  expiration?: number;
  /** v3: opt this order into partial fills (docs/partial-fills.md). */
  allowPartialFill?: boolean;
}

export interface OrderActionParams {
  wallet: WalletContext;
  /** "txHash#index" */
  orderId: string;
}

export interface TakeOrderParams extends OrderActionParams {
  /** v3: take only this much of the offer (absent = full fill). */
  takeAmount?: bigint;
}

export interface TakeLeg {
  orderId: string;
  /** v3: partial fill of this order (absent = full fill). */
  takeAmount?: bigint;
}

export interface TakeManyOrdersParams {
  wallet: WalletContext;
  /** Distinct orders, all consumed atomically in ONE transaction. */
  orders: TakeLeg[];
}

/**
 * Lovelace the TAKER adds to a partial leg's payment output (no deposit is
 * returned on partial fills, so the taker funds the output's ledger
 * min-UTxO). Anything above the ledger floor is a gift to the seller —
 * kept close to the floor for a PaymentTag-carrying output.
 */
const PARTIAL_PAYMENT_LOVELACE = 1_400_000n;

const STANDARD_WARNINGS = [
  "Experimental MVP on Cardano preprod — not audited. Never use mainnet funds.",
  "The backend is not trusted for security: verify this transaction in your wallet before signing.",
  "This summary is backend-provided; full client-side CBOR verification is not implemented yet.",
];

function unitOf(a: AssetClassHex): string {
  return isAda(a) ? "lovelace" : a.policyId + a.assetNameHex;
}

function lovelaceOf(amount: Asset[]): bigint {
  return BigInt(
    amount.find((x) => x.unit === "lovelace" || x.unit === "")?.quantity ?? "0"
  );
}

function quantityOf(amount: Asset[], unit: string): bigint {
  return BigInt(amount.find((x) => x.unit === unit)?.quantity ?? "0");
}

/** deserializeAddress that reports malformed bech32 as a clean 400. */
function parseAddress(addr: string, what: string) {
  try {
    return deserializeAddress(addr);
  } catch {
    throw new BuildError("invalid_request", `${what} is not a valid address`);
  }
}

export class TxBuilder {
  constructor(
    private readonly provider: ChainProvider,
    private readonly scripts: ProtocolScripts,
    private readonly opts: {
      depositLovelace: bigint;
      referenceScript?: { txHash: string; index: number } | undefined;
      /** Batch cap for TakeManyOrders (tx-size/ex-unit budget, not security). */
      maxOrdersPerTx?: number | undefined;
    }
  ) {}

  private get maxOrdersPerTx(): number {
    return this.opts.maxOrdersPerTx ?? 8;
  }

  private newBuilder(): MeshTxBuilder {
    return new MeshTxBuilder({
      fetcher: this.provider.mesh,
      evaluator: this.provider.mesh,
    }).setNetwork("preprod");
  }

  private attachCommon(txb: MeshTxBuilder, wallet: WalletContext): void {
    if (wallet.utxos.length === 0)
      throw new BuildError("invalid_request", "wallet has no UTxOs");
    // Every tx this builder produces touches a Plutus script (beacon mint
    // and/or order-validator spend), so collateral is never optional — a
    // script tx submitted without it is guaranteed to be rejected on-chain
    // (confirmed live: ledger returns NoCollateralInputs). Fail fast with an
    // actionable message instead of building a tx doomed to fail later.
    if (!wallet.collateral)
      throw new BuildError(
        "invalid_request",
        "no collateral UTxO available — your wallet needs a pure-ADA UTxO (>= ~5 ADA, no other tokens) set aside as collateral for script transactions"
      );
    // The collateral UTxO must be excluded from the coin-selection candidate
    // set: passing the full list lets selectUtxosFrom also spend it as a
    // regular input whenever the wallet has few UTxOs, leaving no real
    // collateral in the submitted tx (confirmed live: ledger rejected with
    // NoCollateralInputs / InsufficientCollateral(0) once a small wallet's
    // only spare ADA UTxO got picked for both roles).
    const collateral = wallet.collateral;
    const spendable = collateral
      ? wallet.utxos.filter(
          (u) =>
            u.input.txHash !== collateral.input.txHash ||
            u.input.outputIndex !== collateral.input.outputIndex
        )
      : wallet.utxos;
    if (spendable.length === 0)
      throw new BuildError(
        "invalid_request",
        "wallet has no spendable UTxOs besides the collateral UTxO"
      );
    txb.changeAddress(wallet.changeAddress).selectUtxosFrom(spendable);
    if (collateral) {
      txb.txInCollateral(
        collateral.input.txHash,
        collateral.input.outputIndex,
        collateral.output.amount,
        collateral.output.address
      );
    }
  }

  /**
   * Finalize the tx. Mesh's `.complete()` runs @cardano-sdk's coin selector
   * over exactly the UTxOs `attachCommon` handed it (`wallet.utxos` minus
   * collateral — nothing else, nothing pre-filtered further on our side); on
   * failure it throws a bare `InputSelectionError` with no numbers (e.g.
   * "UTxO Balance Insufficient" — confirmed live: a wallet reporting ~16k ADA
   * total still hit this). Translate that into a diagnostic BuildError; see
   * describeInsufficientFunds() for what it reports and why.
   */
  private async completeTx(
    txb: MeshTxBuilder,
    wallet: WalletContext
  ): Promise<string> {
    try {
      return await txb.complete();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const diagnosis = describeInsufficientFunds(message, wallet);
      if (!diagnosis) throw e; // unrelated bug — don't mask it
      throw diagnosis;
    }
  }

  /**
   * One mint/burn instruction per beacon NAME, all under the beacon policy.
   * Names are aggregated first: a batch that takes two same-pair, same-owner
   * orders burns the SAME five names twice, and the ledger's mint field is a
   * map — that must be one `-2` entry per name, never two `-1` entries.
   */
  private mintBeacons(
    txb: MeshTxBuilder,
    names: string[],
    sign: "1" | "-1"
  ): void {
    const redeemer = sign === "1" ? MINT_BEACONS_REDEEMER : BURN_BEACONS_REDEEMER;
    const counts = new Map<string, number>();
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    for (const [name, count] of counts) {
      const quantity = sign === "1" ? count.toString() : (-count).toString();
      txb
        .mintPlutusScriptV3()
        .mint(quantity, this.scripts.beaconPolicyId, name)
        .mintingScript(this.scripts.beaconPolicyCbor)
        .mintRedeemerValue(redeemer, "Mesh");
    }
  }

  // ---------------------------------------------------------------- create

  async buildCreateOrder(p: CreateOrderParams): Promise<UnsignedTxResponse> {
    const offer = fromApiAssetId(p.offerAsset);
    const ask = fromApiAssetId(p.askAsset);
    if (p.offerAsset === p.askAsset)
      throw new BuildError("invalid_request", "offer and ask must differ");
    if (p.offerAmount <= 0n || p.askAmount <= 0n)
      throw new BuildError("invalid_request", "amounts must be positive");
    if (
      offer.policyId === this.scripts.beaconPolicyId ||
      ask.policyId === this.scripts.beaconPolicyId
    )
      throw new BuildError("invalid_request", "cannot trade beacon tokens");
    if (p.expiration !== undefined && p.expiration <= Date.now())
      throw new BuildError("invalid_request", "expiration is in the past");

    const change = parseAddress(p.wallet.changeAddress, "change address");
    if (!change.stakeCredentialHash)
      throw new BuildError(
        "invalid_request",
        "wallet change address has no staking credential — the MVP identifies owners by staking key"
      );
    if (change.stakeScriptCredentialHash)
      throw new BuildError(
        "invalid_request",
        "script staking credentials are not supported in the MVP"
      );
    const ownerKeyHash = change.stakeCredentialHash;

    const paymentAddress = p.paymentAddress ?? p.wallet.changeAddress;
    const pay = parseAddress(paymentAddress, "payment address");
    if (!pay.pubKeyHash)
      throw new BuildError(
        "invalid_request",
        "payment address must be a key (not script) address in the MVP"
      );

    const names = deriveBeaconNames(offer, ask, ownerKeyHash);
    const orderAddress = this.scripts.orderAddressFor(ownerKeyHash);
    const deposit = this.opts.depositLovelace;

    const datum: OrderDatumFields = {
      version: 1,
      beaconPolicyId: this.scripts.beaconPolicyId,
      ownerKeyHash,
      paymentPubKeyHash: pay.pubKeyHash,
      paymentStakeKeyHash: pay.stakeCredentialHash || null,
      offer,
      offerAmount: p.offerAmount,
      ask,
      askAmount: p.askAmount,
      expiration: p.expiration ?? null,
      allowPartialFill: p.allowPartialFill ?? false,
    };

    const orderAmount: Asset[] = [
      {
        unit: "lovelace",
        quantity: (isAda(offer) ? p.offerAmount + deposit : deposit).toString(),
      },
      ...(isAda(offer)
        ? []
        : [{ unit: unitOf(offer), quantity: p.offerAmount.toString() }]),
      ...Object.values(names).map((n) => ({
        unit: this.scripts.beaconPolicyId + n,
        quantity: "1",
      })),
    ];

    const txb = this.newBuilder();
    this.mintBeacons(txb, Object.values(names), "1");
    txb
      .txOut(orderAddress, orderAmount)
      .txOutInlineDatumValue(encodeOrderDatum(datum), "Mesh");
    this.attachCommon(txb, p.wallet);
    const unsignedTxCborHex = await this.completeTx(txb, p.wallet);

    const summary: TxSummary = {
      action: "create-order",
      network: "preprod",
      description:
        `Lock ${p.offerAmount} of ${p.offerAsset} plus a ${deposit} lovelace deposit ` +
        `in a new order at ${orderAddress}, asking ${p.askAmount} of ${p.askAsset} ` +
        `paid to ${paymentAddress}. Mints the 5 discovery beacons.` +
        (p.allowPartialFill
          ? " Partial fills are ENABLED: takers may fill this order piecewise at the same price."
          : ""),
      offered: { assetId: p.offerAsset, amount: p.offerAmount.toString() },
      requested: { assetId: p.askAsset, amount: p.askAmount.toString() },
      depositLovelace: deposit.toString(),
      beacons: { minted: Object.values(names) },
      orderAddress,
      paymentAddress,
      expiration: p.expiration ?? null,
      warnings: [...STANDARD_WARNINGS],
    };
    return { unsignedTxCborHex, summary };
  }

  // ----------------------------------------------------- shared spend setup

  private async resolveOrder(orderId: string): Promise<{
    txHash: string;
    outputIndex: number;
    utxo: UTxO;
    datum: OrderDatumFields;
    beaconNames: string[];
    deposit: bigint;
  }> {
    const match = /^([0-9a-f]{64})#([0-9]+)$/.exec(orderId);
    if (!match) throw new BuildError("invalid_request", "bad orderId format");
    const [, txHash, indexStr] = match;
    const outputIndex = Number(indexStr);

    const utxo = await this.provider.getUtxo(txHash!, outputIndex);
    if (!utxo)
      throw new BuildError(
        "order_not_found",
        "order UTxO not found on-chain (already taken or cancelled?)"
      );
    if (!utxo.output.plutusData)
      throw new BuildError("not_an_order", "UTxO has no inline datum");
    const datum = decodeOrderDatum(utxo.output.plutusData);
    if (datum.beaconPolicyId !== this.scripts.beaconPolicyId)
      throw new BuildError("not_an_order", "UTxO is not a protocol order");

    // Anti-counterfeit: the UTxO must actually hold the exact beacon set the
    // datum implies (the cache is never trusted for fund paths).
    const names = deriveBeaconNames(datum.offer, datum.ask, datum.ownerKeyHash);
    for (const name of Object.values(names)) {
      if (quantityOf(utxo.output.amount, this.scripts.beaconPolicyId + name) !== 1n)
        throw new BuildError("not_an_order", "UTxO is missing protocol beacons");
    }

    const lovelace = lovelaceOf(utxo.output.amount);
    const deposit = isAda(datum.offer) ? lovelace - datum.offerAmount : lovelace;

    return {
      txHash: txHash!,
      outputIndex,
      utxo,
      datum,
      beaconNames: Object.values(names),
      deposit,
    };
  }

  private spendOrder(
    txb: MeshTxBuilder,
    order: { txHash: string; outputIndex: number; utxo: UTxO },
    redeemer: typeof CANCEL_REDEEMER // any OrderRedeemer as Mesh Data
  ): void {
    txb
      .spendingPlutusScriptV3()
      .txIn(
        order.txHash,
        order.outputIndex,
        order.utxo.output.amount,
        order.utxo.output.address
      )
      .txInInlineDatumPresent()
      .txInRedeemerValue(redeemer, "Mesh");
    if (this.opts.referenceScript) {
      txb.spendingTxInReference(
        this.opts.referenceScript.txHash,
        this.opts.referenceScript.index
      );
    } else {
      txb.txInScript(this.scripts.orderValidatorCbor);
    }
  }

  // ---------------------------------------------------------------- cancel

  async buildCancelOrder(p: OrderActionParams): Promise<UnsignedTxResponse> {
    const order = await this.resolveOrder(p.orderId);

    const txb = this.newBuilder();
    this.spendOrder(txb, order, CANCEL_REDEEMER);
    this.mintBeacons(txb, order.beaconNames, "-1");
    // CancelOrder requires the owner's staking key in extra_signatories.
    txb.requiredSignerHash(order.datum.ownerKeyHash);
    this.attachCommon(txb, p.wallet);
    const unsignedTxCborHex = await this.completeTx(txb, p.wallet);

    const offeredId = toApiAssetId(order.datum.offer);
    const summary: TxSummary = {
      action: "cancel-order",
      network: "preprod",
      description:
        `Cancel order ${p.orderId}: burn its 5 beacons and return ` +
        `${order.datum.offerAmount} of ${offeredId} plus the ${order.deposit} ` +
        `lovelace deposit to your wallet. Requires your staking key signature.`,
      offered: {
        assetId: offeredId,
        amount: order.datum.offerAmount.toString(),
      },
      depositLovelace: order.deposit.toString(),
      beacons: { burned: order.beaconNames },
      orderId: p.orderId,
      warnings: [...STANDARD_WARNINGS],
    };
    return { unsignedTxCborHex, summary };
  }

  // ------------------------------------------------------------------ take

  /** Single take = a batch of one (same tagged-payment shape on-chain). */
  async buildTakeOrder(p: TakeOrderParams): Promise<UnsignedTxResponse> {
    return this.buildTakeManyOrders({
      wallet: p.wallet,
      orders: [
        {
          orderId: p.orderId,
          ...(p.takeAmount !== undefined ? { takeAmount: p.takeAmount } : {}),
        },
      ],
    });
  }

  /**
   * TakeManyOrders (v2, docs/take-many-orders.md; v3 partial legs,
   * docs/partial-fills.md): consume up to maxOrdersPerTx orders in ONE atomic
   * transaction. Every order gets its own seller payment, tagged with an
   * inline PaymentTag naming that order's OutputReference — the rule that
   * keeps double satisfaction closed. Full legs burn their 5 beacons; partial
   * legs instead re-lock a continuation order (deposit + remaining offer +
   * beacons, reduced datum) and pay ceil(take*ask/offer) of the ask.
   */
  async buildTakeManyOrders(p: TakeManyOrdersParams): Promise<UnsignedTxResponse> {
    if (p.orders.length === 0)
      throw new BuildError("invalid_request", "no orders given");
    if (new Set(p.orders.map((o) => o.orderId)).size !== p.orders.length)
      throw new BuildError("invalid_request", "duplicate order ids");
    if (p.orders.length > this.maxOrdersPerTx)
      throw new BuildError(
        "invalid_request",
        `at most ${this.maxOrdersPerTx} orders fit in one transaction — split the route into batches`
      );

    const unsorted = [];
    for (const leg of p.orders) {
      const resolved = await this.resolveOrder(leg.orderId);
      unsorted.push({ ...resolved, orderId: leg.orderId, takeAmount: leg.takeAmount });
    }

    // CRITICAL ORDERING INVARIANT (docs/partial-fills.md §3): the validator
    // rank-pairs partial order inputs (ledger input order = ascending
    // OutputReference) with beacon-bearing outputs (output order). The ledger
    // sorts inputs by (tx hash bytes, then index); we iterate legs in exactly
    // that order and emit each partial leg's continuation inline, so the
    // continuations land in output order matching the input ranks. Payments
    // carry no beacons and the change output comes last — neither disturbs
    // the pairing.
    const orders = [...unsorted].sort((a, b) =>
      a.txHash !== b.txHash
        ? a.txHash < b.txHash
          ? -1
          : 1
        : a.outputIndex - b.outputIndex
    );

    const now = Date.now();
    for (const order of orders) {
      const exp = order.datum.expiration;
      if (exp !== null && exp <= now)
        throw new BuildError(
          "order_expired",
          `order ${order.orderId} has expired — it can only be cancelled by its owner`
        );
    }

    const txb = this.newBuilder();
    const legs: string[] = [];
    const partialFills: PartialFillSummary[] = [];
    const warnings: string[] = [...STANDARD_WARNINGS];
    const burnNames: string[] = [];

    // Taker's EXACT per-asset net over the batch: everything the consumed
    // order UTxOs release, minus everything paid back out to sellers
    // (payments) or re-locked (continuations). Beacons are excluded (burned
    // or carried — never the taker's); fee and change are excluded (the
    // preview shows the fee separately). Unlike the uniform offered/requested
    // aggregates below, this stays meaningful for mixed-asset batches —
    // arbitrage cycles (docs/arbitrage.md) rely on it.
    const takerNet = new Map<string, bigint>();
    const addNet = (amount: Asset[], sign: 1n | -1n) => {
      for (const a of amount) {
        const unit = a.unit === "" ? "lovelace" : a.unit;
        if (unit.startsWith(this.scripts.beaconPolicyId)) continue;
        takerNet.set(
          unit,
          (takerNet.get(unit) ?? 0n) + sign * BigInt(a.quantity)
        );
      }
    };

    for (const order of orders) {
      const { datum, deposit, takeAmount } = order;
      const partial = takeAmount !== undefined;
      addNet(order.utxo.output.amount, 1n);

      const paymentAddress = serializeAddressObj(
        pubKeyAddress(
          datum.paymentPubKeyHash,
          datum.paymentStakeKeyHash ?? undefined,
          false
        ),
        0
      );
      const askUnit = unitOf(datum.ask);

      if (!partial) {
        // -------- full fill (v2 shape): exact ask + deposit, beacons burned.
        this.spendOrder(txb, order, TAKE_REDEEMER);
        burnNames.push(...order.beaconNames);
        const paymentAmount: Asset[] =
          askUnit === "lovelace"
            ? [
                {
                  unit: "lovelace",
                  quantity: (datum.askAmount + deposit).toString(),
                },
              ]
            : [
                { unit: "lovelace", quantity: deposit.toString() },
                { unit: askUnit, quantity: datum.askAmount.toString() },
              ];
        addNet(paymentAmount, -1n);
        txb
          .txOut(paymentAddress, paymentAmount)
          .txOutInlineDatumValue(
            encodePaymentTag(order.txHash, order.outputIndex),
            "Mesh"
          );
        legs.push(
          `${order.orderId}: you receive ${datum.offerAmount} of ${toApiAssetId(datum.offer)}; ` +
            `the seller receives exactly ${datum.askAmount} of ${toApiAssetId(datum.ask)} ` +
            `plus their ${deposit} lovelace deposit at ${paymentAddress}`
        );
        continue;
      }

      // -------- v3 partial fill leg.
      if (!datum.allowPartialFill)
        throw new BuildError(
          "invalid_request",
          `order ${order.orderId} does not allow partial fills — take it fully instead`
        );
      if (takeAmount <= 0n)
        throw new BuildError("invalid_request", "takeAmount must be positive");
      if (takeAmount >= datum.offerAmount)
        throw new BuildError(
          "invalid_request",
          `takeAmount ${takeAmount} is the whole order (${datum.offerAmount}) — omit takeAmount to take it fully (that also returns the seller's deposit)`
        );
      const required = requiredPayment(
        takeAmount,
        datum.askAmount,
        datum.offerAmount
      );
      if (required >= datum.askAmount)
        throw new BuildError(
          "invalid_request",
          `takeAmount ${takeAmount} would exhaust the order's ask (${required} of ${datum.askAmount}) — take the order fully instead`
        );

      this.spendOrder(txb, order, takePartialRedeemer(takeAmount));

      // Payment: exactly `required` of the ask. No deposit returned — the
      // TAKER funds the output's min-ADA on token asks (small seller gift).
      const paymentAmount: Asset[] =
        askUnit === "lovelace"
          ? [
              {
                unit: "lovelace",
                quantity: (required > PARTIAL_PAYMENT_LOVELACE
                  ? required
                  : PARTIAL_PAYMENT_LOVELACE
                ).toString(),
              },
            ]
          : [
              { unit: "lovelace", quantity: PARTIAL_PAYMENT_LOVELACE.toString() },
              { unit: askUnit, quantity: required.toString() },
            ];
      addNet(paymentAmount, -1n);
      txb
        .txOut(paymentAddress, paymentAmount)
        .txOutInlineDatumValue(
          encodePaymentTag(order.txHash, order.outputIndex),
          "Mesh"
        );
      if (askUnit !== "lovelace")
        warnings.push(
          `Partial fill of ${order.orderId}: you add ${PARTIAL_PAYMENT_LOVELACE} lovelace to the seller's payment output (min-ADA — no deposit is returned on partial fills).`
        );
      else if (required < PARTIAL_PAYMENT_LOVELACE)
        warnings.push(
          `Partial fill of ${order.orderId}: payment topped up to ${PARTIAL_PAYMENT_LOVELACE} lovelace (ledger min-ADA) — the excess over ${required} is a gift to the seller.`
        );

      // Continuation: the consumed UTxO's exact value minus the taken offer,
      // re-locked at the SAME order address under the reduced datum.
      const offerUnit = unitOf(datum.offer);
      const continuationAmount: Asset[] = order.utxo.output.amount
        .map((a) => {
          const isOfferEntry =
            a.unit === offerUnit || (offerUnit === "lovelace" && a.unit === "");
          return isOfferEntry
            ? { ...a, quantity: (BigInt(a.quantity) - takeAmount).toString() }
            : a;
        })
        .filter((a) => BigInt(a.quantity) > 0n);
      const continuationDatum: OrderDatumFields = {
        ...datum,
        offerAmount: datum.offerAmount - takeAmount,
        askAmount: datum.askAmount - required,
      };
      addNet(continuationAmount, -1n);
      txb
        .txOut(order.utxo.output.address, continuationAmount)
        .txOutInlineDatumValue(encodeOrderDatum(continuationDatum), "Mesh");

      partialFills.push({
        orderId: order.orderId,
        takeAmount: takeAmount.toString(),
        paidAsk: required.toString(),
        remainingOffer: continuationDatum.offerAmount.toString(),
        remainingAsk: continuationDatum.askAmount.toString(),
        continuationAddress: order.utxo.output.address,
      });
      legs.push(
        `${order.orderId}: PARTIAL — you receive ${takeAmount} of ${toApiAssetId(datum.offer)}; ` +
          `the seller receives ${required} of ${toApiAssetId(datum.ask)} at ${paymentAddress}; ` +
          `the rest (${continuationDatum.offerAmount} offered / ${continuationDatum.askAmount} asked, ` +
          `deposit and beacons included) is re-locked as a continuation order`
      );
    }

    // The whole batch must satisfy EVERY order's expiry: bound the validity
    // interval by the earliest expiration present (upper <= t for each t).
    const expirations = orders
      .map((o) => o.datum.expiration)
      .filter((e): e is number => e !== null);
    if (expirations.length > 0) {
      txb.invalidHereafter(
        unixTimeToEnclosingSlot(
          Math.min(...expirations),
          SLOT_CONFIG_NETWORK.preprod
        )
      );
    }

    // Only FULL legs burn beacons; partial legs carry theirs into the
    // continuation. A pure-partial batch never runs the beacon policy at all.
    if (burnNames.length > 0) this.mintBeacons(txb, burnNames, "-1");
    this.attachCommon(txb, p.wallet);
    const unsignedTxCborHex = await this.completeTx(txb, p.wallet);

    const single = orders.length === 1;
    const first = orders[0]!;
    // Taker-perspective totals: a full leg receives the whole offer and pays
    // the whole ask; a partial leg receives takeAmount and pays required.
    const receivedOf = (o: (typeof orders)[number]) =>
      o.takeAmount !== undefined ? o.takeAmount : o.datum.offerAmount;
    const paidOf = (o: (typeof orders)[number]) =>
      o.takeAmount !== undefined
        ? requiredPayment(o.takeAmount, o.datum.askAmount, o.datum.offerAmount)
        : o.datum.askAmount;
    // Aggregate totals when the batch is uniform (the Smart Fill case:
    // every order offers the same asset and asks the same asset).
    const uniformOffer = orders.every(
      (o) => toApiAssetId(o.datum.offer) === toApiAssetId(first.datum.offer)
    );
    const uniformAsk = orders.every(
      (o) => toApiAssetId(o.datum.ask) === toApiAssetId(first.datum.ask)
    );
    // Deposits are only released (to their sellers) by FULL legs.
    const totalDeposit = orders
      .filter((o) => o.takeAmount === undefined)
      .reduce((s, o) => s + o.deposit, 0n);
    const fullCount = orders.length - partialFills.length;

    const summary: TxSummary = {
      action: single
        ? partialFills.length === 1
          ? "take-order-partial"
          : "take-order"
        : "take-many-orders",
      network: "preprod",
      description: single
        ? partialFills.length === 1
          ? `Partially fill order ${legs[0]}.`
          : `Take order ${legs[0]}. All 5 beacons are burned.`
        : `Take ${orders.length} orders ATOMICALLY in one transaction — all fill together or none do. ` +
          legs.map((l) => `[${l}]`).join(" ") +
          (fullCount > 0
            ? ` The ${5 * fullCount} beacons of the ${fullCount} fully-taken order(s) are burned.`
            : " No beacons are burned (all legs are partial fills)."),
      ...(uniformOffer
        ? {
            offered: {
              assetId: toApiAssetId(first.datum.offer),
              amount: orders.reduce((s, o) => s + receivedOf(o), 0n).toString(),
            },
          }
        : {}),
      ...(uniformAsk
        ? {
            requested: {
              assetId: toApiAssetId(first.datum.ask),
              amount: orders.reduce((s, o) => s + paidOf(o), 0n).toString(),
            },
          }
        : {}),
      takerNet: [...takerNet.entries()]
        .filter(([, v]) => v !== 0n)
        .sort(([ua], [ub]) =>
          ua === "lovelace" ? -1 : ub === "lovelace" ? 1 : ua < ub ? -1 : 1
        )
        .map(([unit, v]) => ({
          assetId:
            unit === "lovelace"
              ? "lovelace"
              : `${unit.slice(0, 56)}.${unit.slice(56)}`,
          amount: v.toString(),
        })),
      depositLovelace: totalDeposit.toString(),
      ...(burnNames.length > 0 ? { beacons: { burned: burnNames } } : {}),
      ...(single
        ? { orderId: first.orderId }
        : { orderIds: orders.map((o) => o.orderId) }),
      ...(partialFills.length > 0 ? { partialFills } : {}),
      ...(single
        ? {
            paymentAddress: serializeAddressObj(
              pubKeyAddress(
                first.datum.paymentPubKeyHash,
                first.datum.paymentStakeKeyHash ?? undefined,
                false
              ),
              0
            ),
          }
        : {}),
      expiration: expirations.length > 0 ? Math.min(...expirations) : null,
      warnings,
    };
    return { unsignedTxCborHex, summary };
  }
}
