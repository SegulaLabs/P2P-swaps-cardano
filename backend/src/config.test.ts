import { describe, expect, it } from "vitest";
import { assertNoKeyMaterial, parseEnv } from "./config.js";

const VALID = {
  CARDANO_NETWORK: "preprod",
  DATABASE_URL: "postgres://x:x@localhost:5432/x",
};

describe("preprod boot guard", () => {
  it("accepts preprod", () => {
    expect(parseEnv(VALID).CARDANO_NETWORK).toBe("preprod");
  });

  it.each(["mainnet", "preview", "testnet", ""])(
    "refuses CARDANO_NETWORK=%s",
    (net) => {
      expect(() => parseEnv({ ...VALID, CARDANO_NETWORK: net })).toThrow(
        /preprod/
      );
    }
  );

  it("refuses a non-preprod Blockfrost project id", () => {
    expect(() =>
      parseEnv({ ...VALID, BLOCKFROST_PROJECT_ID_PREPROD: "mainnetABC" })
    ).toThrow(/preprod/);
  });
});

describe("CHAIN_PROVIDER", () => {
  it("defaults to blockfrost", () => {
    expect(parseEnv(VALID).CHAIN_PROVIDER).toBe("blockfrost");
  });

  it("accepts koios", () => {
    expect(parseEnv({ ...VALID, CHAIN_PROVIDER: "koios" }).CHAIN_PROVIDER).toBe(
      "koios"
    );
  });

  it("refuses an unknown provider", () => {
    expect(() =>
      parseEnv({ ...VALID, CHAIN_PROVIDER: "ogmios" })
    ).toThrow();
  });
});

describe("no-key-material guard", () => {
  it.each([
    "PRIVATE_KEY",
    "WALLET_PRIVATE_KEY",
    "MNEMONIC",
    "SEED_PHRASE",
    "SIGNING_KEY",
    "WALLET_SECRET",
  ])("refuses to boot with %s in the environment", (key) => {
    expect(() => assertNoKeyMaterial({ ...VALID, [key]: "xxx" })).toThrow(
      /forbidden/
    );
    expect(() => parseEnv({ ...VALID, [key]: "xxx" })).toThrow(/forbidden/);
  });

  it("allows a clean environment", () => {
    expect(() => assertNoKeyMaterial(VALID)).not.toThrow();
  });
});
