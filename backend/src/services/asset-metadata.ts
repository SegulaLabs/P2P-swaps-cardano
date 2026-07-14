import type { Pool } from "pg";
import type { ChainProvider } from "./chain-provider.js";
import type { AssetId, AssetInfo } from "../types.js";
import { fromApiAssetId } from "../protocol/beacons.js";

/**
 * Asset display metadata: DB cache -> provider (token registry / on-chain
 * CIP-25/68 via Blockfrost) -> hex fallback. Cosmetic only — NEVER used for
 * on-chain amount math (amounts are always raw integer units).
 */
export class AssetMetadataService {
  constructor(
    private readonly db: Pool | null,
    private readonly provider: ChainProvider | null
  ) {}

  async getAssetInfo(assetId: AssetId): Promise<AssetInfo> {
    if (assetId === "lovelace") {
      return {
        assetId,
        policyId: "",
        assetNameHex: "",
        ticker: "tADA",
        name: "Preprod ADA",
        decimals: 6,
      };
    }
    const { policyId, assetNameHex } = fromApiAssetId(assetId);
    const base: AssetInfo = { assetId, policyId, assetNameHex };

    if (this.db) {
      const cached = await this.db.query(
        `SELECT ticker, display_name, decimals FROM assets WHERE asset_id = $1`,
        [assetId]
      );
      const row = cached.rows[0];
      if (row && (row.ticker || row.display_name)) {
        return {
          ...base,
          ...(row.ticker ? { ticker: row.ticker } : {}),
          ...(row.display_name ? { name: row.display_name } : {}),
          ...(row.decimals != null ? { decimals: row.decimals } : {}),
        };
      }
    }

    if (this.provider) {
      const meta = await this.provider.getAssetMetadata(
        policyId + assetNameHex
      );
      if (meta) {
        const info: AssetInfo = {
          ...base,
          ...(typeof meta.ticker === "string" ? { ticker: meta.ticker } : {}),
          ...(typeof meta.name === "string" ? { name: meta.name } : {}),
          ...(typeof meta.decimals === "number"
            ? { decimals: meta.decimals }
            : {}),
        };
        if (this.db) {
          await this.db.query(
            `INSERT INTO assets (asset_id, policy_id, asset_name_hex, ticker, display_name, decimals)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (asset_id) DO UPDATE SET ticker=$4, display_name=$5, decimals=$6, fetched_at=now()`,
            [
              assetId,
              policyId,
              assetNameHex,
              info.ticker ?? null,
              info.name ?? null,
              info.decimals ?? null,
            ]
          );
        }
        return info;
      }
    }

    // Fallback: show the hex name decoded as UTF-8 when printable.
    const utf8 = Buffer.from(assetNameHex, "hex").toString("utf8");
    return /^[\x20-\x7e]+$/.test(utf8) ? { ...base, name: utf8 } : base;
  }
}
