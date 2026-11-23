import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMcpConfig } from "../index";

const cache = mkdtempSync(join(tmpdir(), "omp-cua-manifests-"));
const channel = "BROWSER_USE_ACCESS_PIPE_PATH";
const identity = "BROWSER_USE_ACCESS_VERIFYING_IDENTITY";
function manifest(version: string, surfaces: string, enabled = true) {
  const dir = join(cache, version);
  mkdirSync(dir, { recursive: true });
  const server = {
    command: "/bin/sh", args: [version], enabled, env_vars: [channel, identity],
    env: { CUA_REPL_ENABLED_SURFACES: surfaces },
  };
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { cua_repl: server } }));
}
afterEach(() => rmSync(cache, { recursive: true, force: true }));

test("uses November's launch spec even with September in the same cache", () => {
  manifest("26.915.31029", "computer");
  manifest("26.1117.41037", "browser,computer");
  const config = resolveMcpConfig(cache, { [channel]: "fixture", [identity]: "fixture" });
  expect(config.args).toEqual(["26.1117.41037"]);
  expect(config.env.CUA_REPL_ENABLED_SURFACES).toBe("browser,computer");
});

test("retains desktop access if either browser host parameter is missing", () => {
  manifest("26.1117.41037", "browser,computer");
  for (const env of [{}, { [channel]: "fixture" }, { [identity]: "fixture" }]) {
    const config = resolveMcpConfig(cache, env);
    expect(config.browserUnavailable).toBe(true);
    expect(config.env.CUA_REPL_ENABLED_SURFACES).toBe("computer");
  }
});

test("honors browser-only and disabled manifests", () => {
  manifest("26.1117.41037", "browser");
  expect(() => resolveMcpConfig(cache, {})).toThrow("host de abas");
  manifest("26.1117.41037", "computer", false);
  expect(() => resolveMcpConfig(cache, {})).toThrow("desativado");
});
