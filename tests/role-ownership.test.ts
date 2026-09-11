/**
 * Tests for extensions/role-ownership.ts (phase 2 ownership sidecar).
 * Run: bun test tests/role-ownership.test.ts
 *
 * Fully self-contained: node:os is mocked so homedir() points at an isolated
 * fixture, matching tests/model-config.test.ts's isolation pattern. The real
 * ~/.pi/agent/gentle-ai/role-profiles.json is never written; its presence and
 * hash are asserted unchanged around the run.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REAL_HOME = homedir(); // captured before the node:os mock is installed
const realSidecarPath = join(REAL_HOME, ".pi/agent/gentle-ai/role-profiles.json");
const realExistedBefore = existsSync(realSidecarPath);
const realHashBefore = realExistedBefore
  ? createHash("sha256").update(readFileSync(realSidecarPath)).digest("hex")
  : null;

const FAKE_HOME = join("/tmp", `mke-ownership-test-${process.pid}`);
mock.module("node:os", () => ({ homedir: () => FAKE_HOME, default: { homedir: () => FAKE_HOME } }));
const mod: any = await import("../extensions/role-ownership.ts");

const fakeSidecarPath = join(FAKE_HOME, ".pi/agent/gentle-ai/role-profiles.json");

describe("fingerprintProfile", () => {
  test("is stable regardless of key order and treats missing vs empty as equal", () => {
    const a = mod.fingerprintProfile({ model: "ollama-mke/x", effort: "high" });
    const b = mod.fingerprintProfile({ effort: "high", model: "ollama-mke/x" });
    expect(a).toBe(b);
  });

  test("distinguishes different profiles", () => {
    const a = mod.fingerprintProfile({ model: "ollama-mke/x", effort: "high" });
    const b = mod.fingerprintProfile({ model: "ollama-mke/x", effort: "medium" });
    expect(a).not.toBe(b);
  });

  test("a missing field normalizes the same as an absent key", () => {
    const a = mod.fingerprintProfile({ model: "ollama-mke/x" });
    const b = mod.fingerprintProfile({ model: "ollama-mke/x", effort: undefined });
    expect(a).toBe(b);
  });
});

describe("computeOwnershipStatus", () => {
  test("no profile at all -> inherited", () => {
    const sidecar = mod.loadRoleOwnership(); // empty, no file yet
    expect(mod.computeOwnershipStatus(sidecar, "sdd-apply", undefined)).toBe("inherited");
    expect(mod.computeOwnershipStatus(sidecar, "sdd-apply", {})).toBe("inherited");
  });

  test("profile exists but sidecar has no record -> custom (never silently adopted)", () => {
    const sidecar = mod.loadRoleOwnership();
    const profile = { model: "ollama-mke/terra", effort: "high" };
    expect(mod.computeOwnershipStatus(sidecar, "sdd-apply", profile)).toBe("custom");
  });

  test("profile matches the last recorded write -> managed", () => {
    let sidecar = mod.loadRoleOwnership();
    const profile = { model: "ollama-mke/terra", effort: "high" };
    sidecar = mod.recordManagedProfile(sidecar, "sdd-apply", profile);
    expect(mod.computeOwnershipStatus(sidecar, "sdd-apply", profile)).toBe("managed");
  });

  test("profile diverges from the last recorded write -> stale-managed, never silently treated as ours", () => {
    let sidecar = mod.loadRoleOwnership();
    sidecar = mod.recordManagedProfile(sidecar, "sdd-apply", { model: "ollama-mke/terra", effort: "high" });
    const editedByHand = { model: "ollama-mke/terra", effort: "medium" };
    expect(mod.computeOwnershipStatus(sidecar, "sdd-apply", editedByHand)).toBe("stale-managed");
  });

  test("forgetRole reverts a managed role to custom once a profile still exists on disk", () => {
    let sidecar = mod.loadRoleOwnership();
    const profile = { model: "ollama-mke/terra", effort: "high" };
    sidecar = mod.recordManagedProfile(sidecar, "sdd-apply", profile);
    sidecar = mod.forgetRole(sidecar, "sdd-apply");
    // The profile itself wasn't touched (still exists) but we no longer claim
    // authorship of it, so a re-apply must treat it as custom, not managed.
    expect(mod.computeOwnershipStatus(sidecar, "sdd-apply", profile)).toBe("custom");
  });

  test("forgetRole on an untracked role is a no-op", () => {
    const sidecar = mod.loadRoleOwnership();
    const same = mod.forgetRole(sidecar, "never-tracked");
    expect(same.roles).toEqual(sidecar.roles);
  });
});

describe("persistence (isolated $HOME)", () => {
  beforeEach(() => {
    rmSync(join(FAKE_HOME, ".pi"), { recursive: true, force: true });
  });

  test("loadRoleOwnership on a missing file returns a valid empty sidecar, never throws", () => {
    const sidecar = mod.loadRoleOwnership();
    expect(sidecar.schema).toBe("gentle-pi.role-profiles/v1");
    expect(sidecar.schemaVersion).toBe(1);
    expect(sidecar.roles).toEqual({});
  });

  test("saveRoleOwnership creates the parent directory and writes valid JSON round-trippable by loadRoleOwnership", () => {
    let sidecar = mod.loadRoleOwnership();
    sidecar = mod.recordManagedProfile(sidecar, "sdd-apply", { model: "ollama-mke/terra", effort: "high" }, "sha256:catalog-abc");
    const backup = mod.saveRoleOwnership(sidecar);
    expect(backup).toBe(""); // nothing existed before this write
    expect(existsSync(fakeSidecarPath)).toBe(true);

    const reloaded = mod.loadRoleOwnership();
    expect(reloaded.roles["sdd-apply"].mode).toBe("managed");
    expect(reloaded.roles["sdd-apply"].catalogFingerprint).toBe("sha256:catalog-abc");
    expect(mod.computeOwnershipStatus(reloaded, "sdd-apply", { model: "ollama-mke/terra", effort: "high" })).toBe("managed");
  });

  test("saveRoleOwnership backs up an existing file before overwriting", () => {
    let sidecar = mod.loadRoleOwnership();
    sidecar = mod.recordManagedProfile(sidecar, "sdd-apply", { model: "ollama-mke/terra", effort: "high" });
    mod.saveRoleOwnership(sidecar); // first write: no backup expected

    sidecar = mod.recordManagedProfile(sidecar, "sdd-design", { model: "ollama-mke/sol", effort: "medium" });
    const backup = mod.saveRoleOwnership(sidecar); // second write: must back up the first
    expect(backup).not.toBe("");
    expect(existsSync(backup)).toBe(true);

    const backedUp = JSON.parse(readFileSync(backup, "utf-8"));
    expect(backedUp.roles["sdd-design"]).toBeUndefined(); // backup predates the second role
    expect(backedUp.roles["sdd-apply"]).toBeDefined();
  });

  test("a corrupt sidecar file degrades to an empty sidecar instead of throwing", () => {
    mkdirSync(join(FAKE_HOME, ".pi", "agent", "gentle-ai"), { recursive: true });
    writeFileSync(fakeSidecarPath, "{ not valid json");
    const sidecar = mod.loadRoleOwnership();
    expect(sidecar.roles).toEqual({});
  });

  test("a well-formed but schema-mismatched file degrades to an empty sidecar", () => {
    mkdirSync(join(FAKE_HOME, ".pi", "agent", "gentle-ai"), { recursive: true });
    writeFileSync(fakeSidecarPath, JSON.stringify({ schema: "some.other/v9", schemaVersion: 1, roles: {} }));
    const sidecar = mod.loadRoleOwnership();
    expect(sidecar.schema).toBe("gentle-pi.role-profiles/v1");
    expect(sidecar.roles).toEqual({});
  });

  test("the real user sidecar is never touched by this suite", () => {
    if (realHashBefore === null) expect(existsSync(realSidecarPath)).toBe(false);
    else expect(createHash("sha256").update(readFileSync(realSidecarPath)).digest("hex")).toBe(realHashBefore);
  });
});
