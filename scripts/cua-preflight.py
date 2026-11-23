#!/usr/bin/env python3
"""cua-preflight — prova o contrato da extensão `omp-codex-computer-use` contra o que
está instalado AGORA, e compara com o pin de upstream.

A extensão não empacota o runtime: consome o que o ChatGPT.app/Codex instalou
(`~/.codex/plugins/cache/openai-bundled/unified-computer-use/<versão>/.mcp.json`).
Atualização do Codex entra sozinha — inclusive uma que quebre o contrato ou que traga
API nova que valha portar. Este script transforma as duas coisas em exit code.

Exit:
  0 PASS       contrato válido e igual ao pin
  3 DRIFT      instalado, mas o contrato que a extensão assume caiu
  4 INFRA      runtime ausente
  5 STALE-PIN  contrato válido, porém upstream mudou (versão/tools/servidor/commit) — revisar e re-pinar

Uso:
  scripts/cua-preflight.py [--json] [--remote] [--update-pin]
    --browser     exige que o host da sessão exponha ao menos um navegador
    --remote      consulta `git ls-remote` do repo de origem (rede; ausência não falha)
    --update-pin  regrava o pin com o estado atual (rodar só depois de olhar o que mudou)
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PIN_PATH = REPO_ROOT / "upstream.json"
PLUGIN_DIR = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "plugins/cache/openai-bundled/unified-computer-use"
REQUIRED_TOOLS = ("js", "js_reset")
PROTOCOL_VERSION = "2024-11-05"

PASS, DRIFT, INFRA, STALE_PIN = 0, 3, 4, 5


class Drift(Exception):
    """Contrato que a extensão assume deixou de valer."""


class Infra(Exception):
    """Runtime não está instalado/materializado."""


def resolve_manifest() -> tuple[str, dict]:
    if not PLUGIN_DIR.is_dir():
        raise Infra(f"{PLUGIN_DIR} não existe (ChatGPT.app não instalado ou plugin não materializado)")
    versions = sorted(
        (p.name for p in PLUGIN_DIR.iterdir() if p.is_dir() and re.fullmatch(r"\d+(?:\.\d+)*", p.name)),
        key=lambda name: tuple(map(int, name.split("."))), reverse=True,
    )
    if not versions:
        raise Infra(f"{PLUGIN_DIR} sem nenhuma versão")
    for version in versions:
        manifest = PLUGIN_DIR / version / ".mcp.json"
        if not manifest.is_file():
            continue
        server = json.loads(manifest.read_text()).get("mcpServers", {}).get("cua_repl")
        if not isinstance(server, dict):
            raise Drift(f"{manifest} não tem mcpServers.cua_repl (versões: {', '.join(versions)})")
        if server.get("enabled") is False:
            raise Infra(f"cua_repl está desativado em {manifest}")
        return version, server
    raise Infra(f"nenhum .mcp.json em {PLUGIN_DIR}/<versão>/ (versões: {', '.join(versions)})")


class Client:
    """Cliente MCP stdio mínimo: o mesmo handshake que a extensão faz."""

    def __init__(self, command: str, args: list[str], env: dict[str, str]) -> None:
        self.proc = subprocess.Popen(
            [command, *args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ, **env},
            text=True,
            bufsize=1,
        )
        self.next_id = 1
        self.stderr = ""
        threading.Thread(target=self._drain_stderr, daemon=True).start()

    def _drain_stderr(self) -> None:
        for line in self.proc.stderr:  # type: ignore[union-attr]
            self.stderr = (self.stderr + line)[-4000:]

    def send(self, payload: dict) -> None:
        self.proc.stdin.write(json.dumps(payload) + "\n")  # type: ignore[union-attr]
        self.proc.stdin.flush()  # type: ignore[union-attr]

    def request(self, method: str, params: dict) -> dict:
        req_id = self.next_id
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
        while True:
            line = self.proc.stdout.readline()  # type: ignore[union-attr]
            if not line:
                raise Drift(f"runtime encerrou durante '{method}'. stderr: {self.stderr.strip() or '(vazio)'}")
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("method") in ("elicitation/create", "mcpServer/elicitation/request") and msg.get("id") is not None:
                self.send({"jsonrpc": "2.0", "id": msg["id"], "result": {"action": "decline"}})
                raise Infra("o runtime pediu confirmação interativa; abra a ferramenta na interface do OMP")
            if msg.get("id") == req_id:
                if "error" in msg:
                    raise Drift(f"'{method}' devolveu erro: {msg['error']}")
                return msg.get("result", {})

    def close(self) -> None:
        self.proc.stdin.close()
        try:
            self.proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.proc.terminate()
            self.proc.wait(timeout=10)


def probe_runtime(require_browser: bool = False) -> dict:
    """Estado vivo do runtime; levanta Drift/Infra quando o contrato não vale."""
    version, server = resolve_manifest()
    command, args = server.get("command"), server.get("args")
    if not isinstance(command, str) or not isinstance(args, list):
        raise Drift(f"mcpServers.cua_repl sem command/args string+lista (versão {version})")
    if not Path(command).exists():
        raise Infra(f"binário do runtime ausente: {command}")
    env = server.get("env") if isinstance(server.get("env"), dict) else {}
    if "CUA_REPL_ENABLED_SURFACES" not in env:
        raise Drift(f"env do manifesto perdeu CUA_REPL_ENABLED_SURFACES (versão {version})")

    surfaces = env["CUA_REPL_ENABLED_SURFACES"].split(",")
    keys = ("BROWSER_USE_ACCESS_PIPE_PATH", "BROWSER_USE_ACCESS_VERIFYING_IDENTITY")
    has_host = all(key in server.get("env_vars", []) and os.environ.get(key) for key in keys)
    if require_browser and "browser" not in surfaces:
        raise Infra("o manifesto não habilita navegador")
    if "browser" in surfaces and not has_host:
        if require_browser or "computer" not in surfaces:
            raise Infra("esta sessão não recebeu o host de abas do Codex")
        env = {**env, "CUA_REPL_ENABLED_SURFACES": "computer"}

    client = Client(command, args, env)
    app_server = None
    try:
        init = client.request(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"elicitation": {"form": {}}},
                "clientInfo": {"name": "cua-preflight", "version": "1.0.0"},
            },
        )
        client.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        info = init.get("serverInfo", {})
        tools = [t.get("name") for t in client.request("tools/list", {}).get("tools", [])]
        missing = [t for t in REQUIRED_TOOLS if t not in tools]
        if missing:
            raise Drift(f"tools ausentes no runtime: {', '.join(missing)} (disponíveis: {', '.join(map(str, tools))})")

        arguments = {"code": "await cua.getState();", "timeout_ms": 30000}
        if cli := env.get("CODEX_CLI_PATH"):
            if not Path(cli).is_file():
                raise Infra(f"CLI do app server ausente: {cli}")
            app_server = Client(cli, ["app-server", "--stdio"], {})
            app_server.request("initialize", {"clientInfo": {"name": "cua-preflight", "version": "1.0.0"}})
            app_server.send({"method": "initialized"})
            thread = app_server.request("thread/start", {"ephemeral": True, "cwd": os.getcwd(), "sandbox": "read-only"})
            result = app_server.request("mcpServer/tool/call", {
                "threadId": thread["thread"]["id"], "server": "cua_repl", "tool": "js", "arguments": arguments,
            })
        else:
            result = client.request("tools/call", {"name": "js", "arguments": arguments})
        parts = [p["text"] for p in result.get("content", []) if p.get("type") == "text"]
        if result.get("isError"):
            reason = " ".join(parts)
            if "sandbox_apply: Operation not permitted" in reason or "sandbox_apply: Operation not permitted" in client.stderr:
                raise Infra("a sandbox desta sessão impediu o macOS de iniciar a sandbox do runtime")
            raise Drift(f"cua.getState falhou: {reason[-600:]}")
        state = None
        for part in parts:
            try:
                value = json.loads(part)
            except ValueError:
                continue
            if isinstance(value, dict) and isinstance(value.get("apps"), list):
                state = value
                break
        if state is None:
            raise Drift("cua.getState não devolveu o inventário de apps")
        errors = state.get("errors", [])
        blocking_errors = [error for error in errors if require_browser or not error.startswith("Browsers:")]
        if blocking_errors:
            raise Infra("; ".join(blocking_errors))
        if require_browser and not state.get("browsers"):
            raise Infra("o host respondeu sem navegadores conectados")
        return {
            "plugin_version": version,
            "server": f"{info.get('name')} {info.get('version')}",
            "protocol_version": init.get("protocolVersion"),
            "tools": tools,
            "apps_visible": len(state["apps"]),
            "browsers_visible": len(state.get("browsers", [])),
            "transport": "codex-app-server" if app_server else "mcp-stdio",
            "inventory_warnings": errors,
        }
    finally:
        if app_server:
            app_server.close()
        client.close()


def git_head(path: Path) -> str | None:
    if not (path / ".git").exists():
        return None
    r = subprocess.run(["git", "-C", str(path), "rev-parse", "HEAD"], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def git_remote_head(repo: str) -> str | None:
    r = subprocess.run(["git", "ls-remote", repo, "HEAD"], capture_output=True, text=True, timeout=60)
    if r.returncode != 0 or not r.stdout.strip():
        return None
    return r.stdout.split()[0]


def compare_pin(live: dict, pin: dict, *, check_remote: bool) -> tuple[list[str], dict]:
    """Deltas entre o pin e o mundo. Contrato já provado por probe_runtime()."""
    deltas: list[str] = []
    observed: dict[str, object] = {}
    pinned_runtime = pin.get("runtime", {})
    for key in ("plugin_version", "server", "protocol_version"):
        want, got = pinned_runtime.get(key), live[key]
        if want != got:
            deltas.append(f"runtime.{key}: pin {want!r} → instalado {got!r}")
    pinned_tools = set(pinned_runtime.get("tools", []))
    live_tools = set(live["tools"])
    if pinned_tools != live_tools:
        added = sorted(live_tools - pinned_tools)
        removed = sorted(pinned_tools - live_tools)
        parts = [f"+{', '.join(added)}" if added else "", f"-{', '.join(removed)}" if removed else ""]
        deltas.append("runtime.tools: " + " ".join(p for p in parts if p))

    upstream = pin.get("upstream_extension", {})
    pinned_commit = upstream.get("commit")
    checkout = Path(os.path.expanduser(upstream.get("checkout", ""))) if upstream.get("checkout") else None
    if checkout:
        local = git_head(checkout)
        observed["upstream_local_commit"] = local
        if local and pinned_commit and local != pinned_commit:
            deltas.append(f"upstream_extension.commit (checkout local): pin {pinned_commit[:7]} → {local[:7]}")
    if check_remote and upstream.get("repo"):
        remote = git_remote_head(upstream["repo"])
        observed["upstream_remote_commit"] = remote or "indisponível"
        if remote and pinned_commit and remote != pinned_commit:
            deltas.append(f"upstream_extension.commit (remoto): pin {pinned_commit[:7]} → {remote[:7]}")
    return deltas, observed


def write_pin(pin: dict, live: dict, observed: dict) -> None:
    pin.setdefault("runtime", {}).update({
        "plugin_version": live["plugin_version"],
        "server": live["server"],
        "protocol_version": live["protocol_version"],
        "tools": live["tools"],
    })
    newest = observed.get("upstream_remote_commit") or observed.get("upstream_local_commit")
    if isinstance(newest, str) and len(newest) == 40:
        pin.setdefault("upstream_extension", {})["commit"] = newest
    pin["verified_at"] = date.today().isoformat()
    PIN_PATH.write_text(json.dumps(pin, ensure_ascii=False, indent=2) + "\n")


def main() -> int:
    argv = sys.argv[1:]
    as_json, check_remote, update_pin = "--json" in argv, "--remote" in argv, "--update-pin" in argv

    try:
        live = probe_runtime(require_browser="--browser" in argv)
    except Drift as err:
        report: dict[str, object] = {"status": "DRIFT", "reason": str(err)}
    except Infra as err:
        report = {"status": "INFRA", "reason": str(err)}
    else:
        if not PIN_PATH.is_file():
            report = {"status": "DRIFT", "reason": f"pin ausente: {PIN_PATH}"}
        else:
            pin = json.loads(PIN_PATH.read_text())
            deltas, observed = compare_pin(live, pin, check_remote=check_remote)
            if deltas and update_pin:
                write_pin(pin, live, observed)
                report = {"status": "PASS", **live, "repinned": deltas}
            elif deltas:
                report = {"status": "STALE-PIN", **live, "deltas": deltas}
            else:
                report = {"status": "PASS", **live}

    code = {"PASS": PASS, "DRIFT": DRIFT, "INFRA": INFRA, "STALE-PIN": STALE_PIN}[str(report["status"])]
    if as_json:
        print(json.dumps(report, ensure_ascii=False))
    elif report["status"] == "PASS":
        print(f"PASS: versão {report['plugin_version']} · {report['server']} · tools {', '.join(map(str, report['tools']))} · apps visíveis {report['apps_visible']}")
        for delta in report.get("repinned", []):  # type: ignore[union-attr]
            print(f"  re-pinado: {delta}")
    elif report["status"] == "STALE-PIN":
        print(f"STALE-PIN: contrato ok (versão {report['plugin_version']}, {report['server']}), pin desatualizado:")
        for delta in report["deltas"]:  # type: ignore[index]
            print(f"  - {delta}")
        print("  revise o que mudou e rode: scripts/cua-preflight.py --update-pin")
    else:
        print(f"{report['status']}: {report['reason']}")
    return code


if __name__ == "__main__":
    sys.exit(main())
