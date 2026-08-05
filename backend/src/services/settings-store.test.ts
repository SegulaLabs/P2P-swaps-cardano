import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { SettingsStore } from "./settings-store.js";

const DEFAULTS = {
  provider: "blockfrost" as const,
  blockfrostProjectId: "",
  koiosApiToken: "",
};

let dirs: string[] = [];
async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "settings-store-"));
  dirs.push(dir);
  return path.join(dir, "settings.json");
}

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

describe("SettingsStore", () => {
  it("falls back to defaults when no file exists yet", async () => {
    const store = await SettingsStore.load(await tmpFile(), DEFAULTS);
    expect(store.get()).toEqual(DEFAULTS);
  });

  it("persists an update and a fresh load reads it back", async () => {
    const file = await tmpFile();
    const store = await SettingsStore.load(file, DEFAULTS);
    await store.update({ provider: "koios", koiosApiToken: "tok" });
    expect(store.get()).toEqual({
      provider: "koios",
      blockfrostProjectId: "",
      koiosApiToken: "tok",
    });

    const reloaded = await SettingsStore.load(file, DEFAULTS);
    expect(reloaded.get()).toEqual(store.get());
  });

  it("activeKey() reads the key for whichever provider is selected", async () => {
    const store = await SettingsStore.load(await tmpFile(), DEFAULTS);
    await store.update({
      provider: "blockfrost",
      blockfrostProjectId: "preprodABC",
    });
    expect(store.activeKey()).toBe("preprodABC");

    await store.update({ provider: "koios", koiosApiToken: "tok" });
    expect(store.activeKey()).toBe("tok");
  });

  it("ignores a corrupt settings file and falls back to defaults", async () => {
    const file = await tmpFile();
    const { writeFile, mkdir } = await import("fs/promises");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "not json");
    const store = await SettingsStore.load(file, DEFAULTS);
    expect(store.get()).toEqual(DEFAULTS);
  });
});
