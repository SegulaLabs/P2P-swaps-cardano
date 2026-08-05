import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";

/**
 * Runtime-editable chain-provider settings (the app's Settings page), kept
 * separate from config.ts's boot-time env vars: this lets a self-hosted
 * user switch Blockfrost/Koios or paste in a key from the browser without
 * restarting the container. Persisted to a small JSON file so it survives
 * restarts; env vars (CHAIN_PROVIDER / BLOCKFROST_PROJECT_ID_PREPROD /
 * KOIOS_API_TOKEN) are only the INITIAL value on first boot.
 *
 * Single-tenant by design, same as the rest of this app (docs/security.md
 * §1): one settings file for the whole self-hosted instance, not per-user.
 * Never holds signing keys — a Blockfrost/Koios API key reads chain data,
 * it can't move funds.
 */

const SettingsSchema = z.object({
  provider: z.enum(["blockfrost", "koios"]),
  blockfrostProjectId: z.string().default(""),
  koiosApiToken: z.string().default(""),
});

export type ChainProviderSettings = z.infer<typeof SettingsSchema>;

export class SettingsStore {
  private current: ChainProviderSettings;

  constructor(
    private readonly filePath: string,
    defaults: ChainProviderSettings
  ) {
    this.current = defaults;
  }

  static async load(
    filePath: string,
    defaults: ChainProviderSettings
  ): Promise<SettingsStore> {
    const store = new SettingsStore(filePath, defaults);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      store.current = SettingsSchema.parse(JSON.parse(raw));
    } catch {
      // No settings file yet (or it's unreadable/invalid) — env defaults stand.
    }
    return store;
  }

  get(): ChainProviderSettings {
    return this.current;
  }

  /** The key relevant to the currently-selected provider, "" if unset. */
  activeKey(): string {
    return this.current.provider === "koios"
      ? this.current.koiosApiToken
      : this.current.blockfrostProjectId;
  }

  async update(patch: Partial<ChainProviderSettings>): Promise<ChainProviderSettings> {
    const next = SettingsSchema.parse({ ...this.current, ...patch });
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(next, null, 2));
    this.current = next;
    return next;
  }
}
