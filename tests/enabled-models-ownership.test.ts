/**
 * Tests for extensions/enabled-models-ownership.ts.
 * Run: bun test tests/enabled-models-ownership.test.ts
 *
 * Fully self-contained: node:os is mocked so homedir() points at an isolated
 * fixture, matching tests/role-ownership.test.ts's isolation pattern. The
 * real ~/.pi/agent/settings.json and ~/.pi/agent/gentle-ai/enabled-models-
 * ownership.json are never written; their presence and hash are asserted
 * unchanged around the run.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REAL_HOME = homedir(); // captured before the node:os mock is installed
const realSettingsPath = join(REAL_HOME, ".pi/agent/settings.json");
const realSidecarPath = join(REAL_HOME, ".pi/agent/gentle-ai/enabled-models-ownership.json");
const realSettingsExistedBefore = existsSync(realSettingsPath);
const realSettingsHashBefore = realSettingsExistedBefore
  ? createHash("sha256").update(readFileSync(realSettingsPath)).digest("hex")
  : null;
const realSidecarExistedBefore = existsSync(realSidecarPath);
const realSidecarHashBefore = realSidecarExistedBefore
  ? createHash("sha256").update(readFileSync(realSidecarPath)).digest("hex")
  : null;

const FAKE_HOME = join("/tmp", `mke-enabled-models-test-${process.pid}`);
mock.module("node:os", () => ({ homedir: () => FAKE_HOME, default: { homedir: () => FAKE_HOME } }));
const mod: any = await import("../extensions/enabled-models-ownership.ts");

const fakeSettingsPath = join(FAKE_HOME, ".pi/agent/settings.json");
const fakeSidecarPath = join(FAKE_HOME, ".pi/agent/gentle-ai/enabled-models-ownership.json");

function writeFakeSettings(contents: Record<string, unknown>) {
  mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
  writeFileSync(fakeSettingsPath, `${JSON.stringify(contents, null, 2)}\n`, "utf-8");
}

describe("alreadyGrantsAllOllamaMkeModels", () => {
  test("undefined (no enabledModels key) already grants everything", () => {
    expect(mod.alreadyGrantsAllOllamaMkeModels(undefined)).toBe(true);
  });

  test("an empty array already grants everything", () => {
    expect(mod.alreadyGrantsAllOllamaMkeModels([])).toBe(true);
  });

  test("a list already containing the wildcard grants everything", () => {
    expect(mod.alreadyGrantsAllOllamaMkeModels(["ollama-mke/*"])).toBe(true);
  });

  test("a list containing the wildcard among other explicit ids still grants everything", () => {
    expect(mod.alreadyGrantsAllOllamaMkeModels(["ollama-mke/claude-sonnet-5", "ollama-mke/*"])).toBe(true);
  });

  test("a closed list of explicit ids without the wildcard does not grant everything", () => {
    expect(mod.alreadyGrantsAllOllamaMkeModels(["ollama-mke/claude-sonnet-5", "ollama-mke/codex-gpt56-terra"])).toBe(
      false
    );
  });
});

describe("computeEnabledModelsStatus", () => {
  test("no current value -> unset", () => {
    const sidecar = mod.loadEnabledModelsOwnership();
    expect(mod.computeEnabledModelsStatus(sidecar, undefined)).toBe("unset");
    expect(mod.computeEnabledModelsStatus(sidecar, [])).toBe("unset");
  });

  test("a closed list with no sidecar record -> custom (never silently adopted)", () => {
    const sidecar = mod.loadEnabledModelsOwnership(); // empty, no file yet
    expect(mod.computeEnabledModelsStatus(sidecar, ["ollama-mke/claude-sonnet-5"])).toBe("custom");
  });

  test("a value matching the last recorded write -> managed", () => {
    let sidecar = mod.loadEnabledModelsOwnership();
    sidecar = mod.recordManagedEnabledModels(sidecar, ["ollama-mke/*"]);
    expect(mod.computeEnabledModelsStatus(sidecar, ["ollama-mke/*"])).toBe("managed");
  });

  test("a value diverging from the last recorded write -> custom, never silently treated as ours", () => {
    let sidecar = mod.loadEnabledModelsOwnership();
    sidecar = mod.recordManagedEnabledModels(sidecar, ["ollama-mke/*"]);
    // A human hand-edited it back to a closed list since our last write.
    expect(mod.computeEnabledModelsStatus(sidecar, ["ollama-mke/claude-sonnet-5"])).toBe("custom");
  });
});

describe("readCurrentEnabledModels", () => {
  beforeEach(() => {
    rmSync(join(FAKE_HOME, ".pi"), { recursive: true, force: true });
  });

  test("missing settings.json -> undefined", () => {
    expect(mod.readCurrentEnabledModels()).toBeUndefined();
  });

  test("settings.json without enabledModels -> undefined", () => {
    writeFakeSettings({ defaultModel: "claude-sonnet-5" });
    expect(mod.readCurrentEnabledModels()).toBeUndefined();
  });

  test("settings.json with a string-array enabledModels -> that array", () => {
    writeFakeSettings({ enabledModels: ["ollama-mke/claude-sonnet-5", "ollama-mke/codex-gpt56-terra"] });
    expect(mod.readCurrentEnabledModels()).toEqual(["ollama-mke/claude-sonnet-5", "ollama-mke/codex-gpt56-terra"]);
  });

  test("settings.json with a non-array enabledModels -> undefined, never throws", () => {
    writeFakeSettings({ enabledModels: "not-an-array" });
    expect(mod.readCurrentEnabledModels()).toBeUndefined();
  });

  test("corrupt settings.json -> undefined, never throws", () => {
    mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
    writeFileSync(fakeSettingsPath, "{ not valid json");
    expect(mod.readCurrentEnabledModels()).toBeUndefined();
  });

  test("settings.json with // comments and trailing commas still parses", () => {
    mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
    writeFileSync(
      fakeSettingsPath,
      '{\n  // a comment\n  "enabledModels": ["ollama-mke/claude-sonnet-5",],\n}\n'
    );
    expect(mod.readCurrentEnabledModels()).toEqual(["ollama-mke/claude-sonnet-5"]);
  });
});

describe("writeManagedEnabledModels", () => {
  beforeEach(() => {
    rmSync(join(FAKE_HOME, ".pi"), { recursive: true, force: true });
  });

  test("creates settings.json with the wildcard when none existed, no backup expected", () => {
    const { backupPath, written } = mod.writeManagedEnabledModels();
    expect(backupPath).toBe("");
    expect(written).toEqual(["ollama-mke/*"]);
    expect(mod.readCurrentEnabledModels()).toEqual(["ollama-mke/*"]);
  });

  test("preserves every other key already in settings.json", () => {
    writeFakeSettings({
      defaultModel: "claude-sonnet-5",
      defaultProvider: "ollama-mke",
      enabledModels: ["ollama-mke/claude-sonnet-5"],
      theme: "Gentleman-Sexy",
    });
    mod.writeManagedEnabledModels();
    const reloaded = JSON.parse(readFileSync(fakeSettingsPath, "utf-8"));
    expect(reloaded.defaultModel).toBe("claude-sonnet-5");
    expect(reloaded.defaultProvider).toBe("ollama-mke");
    expect(reloaded.theme).toBe("Gentleman-Sexy");
    expect(reloaded.enabledModels).toEqual(["ollama-mke/*"]);
  });

  test("backs up an existing settings.json before overwriting", () => {
    writeFakeSettings({ enabledModels: ["ollama-mke/claude-sonnet-5"] });
    const { backupPath } = mod.writeManagedEnabledModels();
    expect(backupPath).not.toBe("");
    expect(existsSync(backupPath)).toBe(true);
    const backedUp = JSON.parse(readFileSync(backupPath, "utf-8"));
    expect(backedUp.enabledModels).toEqual(["ollama-mke/claude-sonnet-5"]);
  });

  test("throws on a corrupt settings.json rather than silently dropping unknown keys", () => {
    mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
    writeFileSync(fakeSettingsPath, "{ not valid json");
    expect(() => mod.writeManagedEnabledModels()).toThrow();
  });
});

describe("persistence (isolated $HOME)", () => {
  beforeEach(() => {
    rmSync(join(FAKE_HOME, ".pi"), { recursive: true, force: true });
  });

  test("loadEnabledModelsOwnership on a missing file returns a valid empty sidecar, never throws", () => {
    const sidecar = mod.loadEnabledModelsOwnership();
    expect(sidecar.schema).toBe("pi-litellm-ollama-mke.enabled-models-ownership/v1");
    expect(sidecar.schemaVersion).toBe(1);
    expect(sidecar.lastWritten).toBeUndefined();
  });

  test("saveEnabledModelsOwnership creates the parent directory and writes valid JSON round-trippable by loadEnabledModelsOwnership", () => {
    let sidecar = mod.loadEnabledModelsOwnership();
    sidecar = mod.recordManagedEnabledModels(sidecar, ["ollama-mke/*"]);
    const backup = mod.saveEnabledModelsOwnership(sidecar);
    expect(backup).toBe(""); // nothing existed before this write
    expect(existsSync(fakeSidecarPath)).toBe(true);

    const reloaded = mod.loadEnabledModelsOwnership();
    expect(reloaded.lastWritten).toEqual(["ollama-mke/*"]);
    expect(mod.computeEnabledModelsStatus(reloaded, ["ollama-mke/*"])).toBe("managed");
  });

  test("saveEnabledModelsOwnership backs up an existing file before overwriting", () => {
    let sidecar = mod.loadEnabledModelsOwnership();
    sidecar = mod.recordManagedEnabledModels(sidecar, ["ollama-mke/*"]);
    mod.saveEnabledModelsOwnership(sidecar); // first write: no backup expected

    sidecar = mod.recordManagedEnabledModels(sidecar, ["ollama-mke/*", "extra/x"]);
    const backup = mod.saveEnabledModelsOwnership(sidecar); // second write: must back up the first
    expect(backup).not.toBe("");
    expect(existsSync(backup)).toBe(true);

    const backedUp = JSON.parse(readFileSync(backup, "utf-8"));
    expect(backedUp.lastWritten).toEqual(["ollama-mke/*"]);
  });

  test("a corrupt sidecar file degrades to an empty sidecar instead of throwing", () => {
    mkdirSync(join(FAKE_HOME, ".pi", "agent", "gentle-ai"), { recursive: true });
    writeFileSync(fakeSidecarPath, "{ not valid json");
    const sidecar = mod.loadEnabledModelsOwnership();
    expect(sidecar.lastWritten).toBeUndefined();
  });

  test("a well-formed but schema-mismatched file degrades to an empty sidecar", () => {
    mkdirSync(join(FAKE_HOME, ".pi", "agent", "gentle-ai"), { recursive: true });
    writeFileSync(fakeSidecarPath, JSON.stringify({ schema: "some.other/v9", schemaVersion: 1 }));
    const sidecar = mod.loadEnabledModelsOwnership();
    expect(sidecar.schema).toBe("pi-litellm-ollama-mke.enabled-models-ownership/v1");
    expect(sidecar.lastWritten).toBeUndefined();
  });

  test("end-to-end: unset -> managed rewrite -> status reads managed on next run", () => {
    // First run: nothing configured, so status is "unset" and nothing to do.
    let sidecar = mod.loadEnabledModelsOwnership();
    expect(mod.computeEnabledModelsStatus(sidecar, mod.readCurrentEnabledModels())).toBe("unset");

    // A human later writes a closed list by hand (simulating an old setup.mjs).
    writeFakeSettings({ enabledModels: ["ollama-mke/claude-sonnet-5"] });
    expect(mod.computeEnabledModelsStatus(sidecar, mod.readCurrentEnabledModels())).toBe("custom");

    // Now this plugin writes the wildcard and records it.
    const { written } = mod.writeManagedEnabledModels();
    sidecar = mod.recordManagedEnabledModels(sidecar, written);
    mod.saveEnabledModelsOwnership(sidecar);

    // Next run: reloaded sidecar + reloaded settings agree it's "managed".
    const reloadedSidecar = mod.loadEnabledModelsOwnership();
    expect(mod.computeEnabledModelsStatus(reloadedSidecar, mod.readCurrentEnabledModels())).toBe("managed");
    expect(mod.alreadyGrantsAllOllamaMkeModels(mod.readCurrentEnabledModels())).toBe(true);
  });

  test("the real user settings.json is never touched by this suite", () => {
    if (realSettingsHashBefore === null) expect(existsSync(realSettingsPath)).toBe(false);
    else expect(createHash("sha256").update(readFileSync(realSettingsPath)).digest("hex")).toBe(realSettingsHashBefore);
  });

  test("the real user sidecar is never touched by this suite", () => {
    if (realSidecarHashBefore === null) expect(existsSync(realSidecarPath)).toBe(false);
    else expect(createHash("sha256").update(readFileSync(realSidecarPath)).digest("hex")).toBe(realSidecarHashBefore);
  });
});
