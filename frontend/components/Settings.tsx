"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { ChainProviderSettings } from "@/lib/types";
import { Callout } from "./Callout";

type Status =
  | { step: "loading" }
  | { step: "unavailable" }
  | { step: "ready"; settings: ChainProviderSettings }
  | { step: "saving"; settings: ChainProviderSettings }
  | { step: "error"; settings: ChainProviderSettings; message: string };

/**
 * Chain-provider settings — self-hosted operators point this backend at
 * Blockfrost (needs a free preprod project id) or Koios (works with no
 * key, or an optional token for a higher rate limit). Applied live, no
 * restart: PUT /settings hot-swaps the running provider (backend/src/index.ts
 * applySettings) and this form shows the result of a real connectivity
 * check, not just "saved".
 *
 * A pure env-var deployment (no Settings page wired up, e.g. an operator
 * who only ever edits .env) gets a plain 503 here — that's expected, not
 * an error to alarm over.
 */
export function Settings() {
  const [status, setStatus] = useState<Status>({ step: "loading" });
  const [provider, setProvider] = useState<"blockfrost" | "koios">("blockfrost");
  const [blockfrostProjectId, setBlockfrostProjectId] = useState("");
  const [koiosApiToken, setKoiosApiToken] = useState("");

  useEffect(() => {
    api
      .settings()
      .then((s) => {
        setStatus({ step: "ready", settings: s });
        setProvider(s.provider);
        setBlockfrostProjectId(s.blockfrostProjectId);
        setKoiosApiToken(s.koiosApiToken);
      })
      .catch(() => setStatus({ step: "unavailable" }));
  }, []);

  if (status.step === "loading") return null;

  if (status.step === "unavailable") {
    return (
      <Callout label="ENV-ONLY" tone="info">
        This instance doesn&apos;t have the Settings page wired up — the
        chain provider is fixed at deploy time via <code>CHAIN_PROVIDER</code>,{" "}
        <code>BLOCKFROST_PROJECT_ID_PREPROD</code> / <code>KOIOS_API_TOKEN</code>{" "}
        in <code>.env</code>. See <code>.env.example</code>.
      </Callout>
    );
  }

  async function save(e: React.FormEvent, current: ChainProviderSettings) {
    e.preventDefault();
    setStatus({ step: "saving", settings: current });
    try {
      const updated = await api.updateSettings({
        provider,
        blockfrostProjectId,
        koiosApiToken,
      });
      setStatus({ step: "ready", settings: updated });
    } catch (err) {
      setStatus({
        step: "error",
        settings: current,
        message: err instanceof ApiError ? err.message : "Failed to save",
      });
    }
  }

  const saving = status.step === "saving";

  return (
    <form className="card" onSubmit={(e) => save(e, status.settings)}>
      <p className="muted">
        Choose which service the backend uses to read the Cardano chain and
        submit your signed transactions. Neither option ever sees your
        wallet keys — your wallet signs every transaction locally
        (docs/security.md).
      </p>

      <div className="field">
        <label htmlFor="provider-select">Chain provider</label>
        <select
          id="provider-select"
          value={provider}
          onChange={(e) => setProvider(e.target.value as "blockfrost" | "koios")}
        >
          <option value="blockfrost">Blockfrost</option>
          <option value="koios">Koios</option>
        </select>
      </div>

      {provider === "blockfrost" ? (
        <div className="field">
          <label htmlFor="blockfrost-key">
            Blockfrost preprod project id
          </label>
          <input
            id="blockfrost-key"
            value={blockfrostProjectId}
            onChange={(e) => setBlockfrostProjectId(e.target.value)}
            placeholder="preprodXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
          />
          <p className="muted">
            Free at{" "}
            <a href="https://blockfrost.io" target="_blank" rel="noreferrer">
              blockfrost.io
            </a>{" "}
            — create a <strong>preprod</strong> project.
          </p>
        </div>
      ) : (
        <div className="field">
          <label htmlFor="koios-token">
            Koios API token (optional)
          </label>
          <input
            id="koios-token"
            value={koiosApiToken}
            onChange={(e) => setKoiosApiToken(e.target.value)}
            placeholder="leave blank for the free public tier"
          />
          <p className="muted">
            Koios works with no key at all. An optional token from{" "}
            <a href="https://koios.rest" target="_blank" rel="noreferrer">
              koios.rest
            </a>{" "}
            raises the public rate limit.
          </p>
        </div>
      )}

      {status.step === "error" && (
        <p className="warn">⚠ {status.message}</p>
      )}
      {status.step === "ready" && status.settings.active && (
        <p className="muted">
          Currently live: <strong>{status.settings.active}</strong>
        </p>
      )}

      <button type="submit" className="btn btn-primary" disabled={saving}>
        {saving ? "Checking connection…" : "Save"}
      </button>
    </form>
  );
}
