/**
 * Pure form/flow validation helpers — no Mesh imports, unit-testable.
 */

export const ASSET_ID_RE = /^(lovelace|[0-9a-f]{56}\.[0-9a-f]{0,64})$/;

export interface CreateOrderInput {
  offerAsset: string;
  offerAmount: string;
  askAsset: string;
  askAmount: string;
  paymentAddress?: string;
  /** ISO datetime-local string or "" */
  expiration?: string;
}

export interface CreateOrderValidated {
  offerAsset: string;
  offerAmount: string;
  askAsset: string;
  askAmount: string;
  paymentAddress?: string;
  expiration?: number;
}

export function assembleAssetId(policyId: string, assetNameHex: string): string {
  const p = policyId.trim().toLowerCase();
  const n = assetNameHex.trim().toLowerCase();
  if (p === "" && n === "") return "lovelace";
  return `${p}.${n}`;
}

/** Returns { errors } or { value } — amounts are raw integer units. */
export function validateCreateOrder(input: CreateOrderInput):
  | { errors: string[] }
  | { value: CreateOrderValidated } {
  const errors: string[] = [];

  if (!ASSET_ID_RE.test(input.offerAsset))
    errors.push("offered asset must be 'lovelace' or policyIdHex.assetNameHex");
  if (!ASSET_ID_RE.test(input.askAsset))
    errors.push("requested asset must be 'lovelace' or policyIdHex.assetNameHex");
  if (input.offerAsset === input.askAsset)
    errors.push("offered and requested assets must differ");

  for (const [label, raw] of [
    ["offered amount", input.offerAmount],
    ["requested amount", input.askAmount],
  ] as const) {
    if (!/^[0-9]+$/.test(raw) || BigInt(raw || "0") <= 0n)
      errors.push(`${label} must be a positive integer (raw on-chain units)`);
  }

  let expiration: number | undefined;
  if (input.expiration) {
    const ms = new Date(input.expiration).getTime();
    if (Number.isNaN(ms)) errors.push("expiration is not a valid date");
    else if (ms <= Date.now()) errors.push("expiration must be in the future");
    else expiration = ms;
  }

  if (errors.length > 0) return { errors };
  return {
    value: {
      offerAsset: input.offerAsset,
      offerAmount: input.offerAmount,
      askAsset: input.askAsset,
      askAmount: input.askAmount,
      ...(input.paymentAddress?.trim()
        ? { paymentAddress: input.paymentAddress.trim() }
        : {}),
      ...(expiration !== undefined ? { expiration } : {}),
    },
  };
}

export function shortId(id: string, keep = 10): string {
  return id.length <= keep * 2 ? id : `${id.slice(0, keep)}…${id.slice(-6)}`;
}

export function formatAsset(assetId: string): string {
  if (assetId === "lovelace") return "lovelace (tADA×10⁻⁶)";
  const [policy, name] = assetId.split(".");
  let printable = "";
  try {
    const utf8 = Buffer.from(name ?? "", "hex").toString("utf8");
    if (/^[\x20-\x7e]+$/.test(utf8)) printable = ` (“${utf8}”)`;
  } catch {
    /* hex only */
  }
  return `${shortId(policy ?? "", 8)}.${name}${printable}`;
}
