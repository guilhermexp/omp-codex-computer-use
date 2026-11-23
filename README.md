# omp-codex-computer-use

Codex's native macOS **Computer Use** runtime (`cua_repl`) exposed as tools for the [oh-my-pi (`omp`)](https://github.com/guilhermexp) coding agent.

Port of [`pi-codex-computer-use`](https://github.com/guilhermexp/pi-codex-computer-use) (host Pi) to omp's `ExtensionAPI`.

The extension bundles no runtime. It resolves whatever Codex installed at
`~/.codex/plugins/cache/openai-bundled/unified-computer-use/<version>/.mcp.json` and uses the Codex app server when the manifest provides its CLI. Older manifests use MCP over stdio.

## Install

```bash
omp plugin install github:guilhermexp/omp-codex-computer-use
```

Local checkout instead:

```bash
omp plugin link /path/to/omp-codex-computer-use
```

Start a new omp session afterwards; extensions load at session start.

## Requirements

- macOS.
- **ChatGPT.app installed** (the runtime lives in its bundle: `/Applications/ChatGPT.app/Contents/Resources/cua_node/`). It does **not** need to be running — the `SkyComputerUseService` helper is launched on demand. Uninstalling ChatGPT.app breaks the extension.
- Accessibility permission granted to **`Codex Computer Use.app`** (`~/.codex/computer-use/`), not to ChatGPT.app.

On the November 2026 runtime, OMP opens its own ephemeral, read-only thread through the Codex app server. Native apps authenticate through that connection. Direct browser access also depends on the browser host and an active Codex turn. Run `scripts/cua-preflight.py --browser` to check browser availability explicitly.

## Tools

### `codex_computer_use`

Evaluates JavaScript in the `cua_repl` runtime. REPL state (variables, app/tab handles) persists across calls while that REPL lives; when it is replaced the first line of the result says so, so you rebind instead of hitting `x is not defined`.

| Param | Type | Notes |
|---|---|---|
| `code` | string | statements evaluated in the runtime |
| `timeout_ms` | integer | 1000–300000, default 30000 |

Runtime API (current verified build in `upstream.json`):

```js
await cua.getState()                       // running apps: displayName + bundle id, plus browsers
await cua.listApps()                       // every installed app
const app = await cua.getApp("Finder")     // name, path or bundle id; launches if needed
await app.getAXState({ disableDiffing: true })
await app.getScreenshot()                  // window-only image; the runtime returns JPEG while announcing PNG
await app.getAXStateAndScreenshot(opts)    // both in one round trip
await app.click(index | [x, y])
await app.paste("text", { format })        // inserts the exact literal
await app.typeText("text")                 // key by key, subject to the field's autocorrect
await app.setValue(index, "value")         // "(settable)" nodes only — and still a silent no-op on some toolkits
await app.selectText(index, "text", { prefix, suffix })
await app.pressKey("Return" | "super+n" | "Tab")
await app.scroll(index | [x, y], "down", pages)
await app.drag([x1, y1], [x2, y2])
await app.performSecondaryAction(index, "Raise")
nodeRepl.write(text)
await nodeRepl.emitImage(bytes)
```

### `codex_computer_use_reset`

Resets the persistent REPL (`js_reset`) without closing windows or apps.

## Behavior worth knowing (measured, not assumed)

- **Runs in the background.** 18 actions with another app frontmost: AX reads, screenshots, `click`, `scroll`, `drag`, `pressKey` and `typeText` never activated the target app and never moved the real pointer. What does steal focus: opening a window (`super+n`) or launching an app that was closed.
- **Screenshots are per window, not per screen.** A user window on top does not appear in the capture.
- **The agent cursor is real but conditional.** Coordinate actions (`click([x,y])`, `scroll([x,y])`, `drag`) make the service draw a synthetic arrow at the target — the pointer you see when Codex drives the machine. Node-index actions draw nothing. Either way the user's pointer never moves.
- **Only the target app's frontmost window is visible.** There is no window list and no window id in this surface (`cua.computer.target === "mac"`); multi-window apps need `performSecondaryAction(index, "Raise")` first.
- **Neither `typeText` nor `setValue` is trustworthy alone.** TextEdit turned `omp` into `Omp` (autocapitalize); `setValue` on a GPUI app (Zeron's search field, node marked `(settable)`) returned success and changed nothing. Prefer `paste()` for literals, and re-read the node's `Value` after writing either way.
- **Node indexes expire on every action.** Call `getAXState` and act in the *same* tool call; never reuse an index from a previous call.
- **Match nodes by `ID:`, not by label.** A pt-BR macOS reports `botão Apagar`, not `Don't Save`; the `ID:` (`DontSaveButton`) is stable.
- **iPad/iPhone apps on the Mac need the running bundle path.** macOS runs them from a copy at `/private/var/folders/.../Wrapper/X.app` that shares the bundle id with `/Applications/X.app`. `getApp("<bundle.id>")` throws `Ambiguous app identifier`, and `getApp("X")` or `getApp("/Applications/X.app")` throws `Running application not found`. Read the path with `lsappinfo info -only bundlepath <bundle.id>` and pass it to `getApp`; the UUID in it changes when the app relaunches.

## Differences from the Pi version

- No hardcoded path/version fallback: without a resolvable `.mcp.json` the tool fails naming the missing path instead of guessing a stale bundle version.
- The runtime's ~19 KB instruction preamble is forwarded only on the first call of an **agent session**, and that fact is stored on disk (`$TMPDIR/omp-codex-cua/session-<id>.json`) rather than in memory, because the host process that loads this extension is recycled mid-conversation (measured: `omp --mode rpc-ui` pids 12020 → 39121 → 1472 inside one session). A memory flag re-sent the whole preamble after every swap.
- Losing the REPL is therefore normal, not exceptional: each new REPL bumps a durable boot counter, and any boot after the first is announced as `[cua_repl reiniciou — …]`. There is no idle timeout to fight — a standalone bridge held its REPL and its variables across 600s of silence with no heartbeat (measured, ± control).
- Image `mimeType` is sniffed from the bytes, not taken from the runtime's label: it announces `image/png` and sends JPEG, and a host that trusts the label rejects the image entirely.
- Every screenshot is written to `$TMPDIR/omp-codex-cua/shot-<pid>-<n>.<real-ext>` and the paths are appended to the tool result, so a run leaves evidence on disk.
- `session_shutdown` kills the spawned `cua_repl`; no orphan processes.

## Proving the bridge

The bridge can only be proven against a live `cua_repl`, so the smoke harness mounts the extension itself — twice, with the same agent session id, which is exactly the host recycling that breaks a real session.

```bash
bun scripts/bridge-smoke.ts ./index.ts FIXED
git show HEAD:index.ts > /tmp/before.ts && bun scripts/bridge-smoke.ts /tmp/before.ts BEFORE   # ± control
```

It asserts the preamble goes out once and never again, that the REPL keeps its variables between calls, that a recycled host announces the state loss instead of going silent, and that the image mimeType and file extension match the actual bytes. It also reads the Finder window through the same transport.

## Upstream drift

`upstream.json` pins what this extension consumes from third parties: the Codex plugin version, `serverInfo`, MCP protocol version, the runtime tool names, and the commit of the Pi extension this was ported from.

```bash
scripts/cua-preflight.py            # 0 PASS · 3 DRIFT · 4 INFRA · 5 STALE-PIN
scripts/cua-preflight.py --remote   # also compares the upstream repo HEAD
scripts/cua-preflight.py --browser      # requires a browser in the current session
scripts/cua-preflight.py --json
scripts/cua-preflight.py --update-pin   # re-pin after reviewing what changed
```

| exit | meaning | action |
|---|---|---|
| 0 | contract valid and identical to the pin | nothing |
| 3 | `DRIFT` — an assumption broke (tool renamed, manifest shape changed, API gone) | patch the extension; the message names the piece |
| 4 | `INFRA` — runtime not installed | install/open ChatGPT.app |
| 5 | `STALE-PIN` — still works, but upstream moved | review the deltas, then `--update-pin` |

Codex updates flow in by themselves (the plugin version jumped `26.908.70816` → `26.915.31029` and the extension kept working untouched); the assumptions listed above do not. Run the preflight after a ChatGPT.app update.

## Safety

Computer Use delivers keystrokes and clicks through the Accessibility API, so **nothing passes through shell-command guards** that inspect `bash` input. Never point it at an open terminal, shell or REPL. Isolation is the target app's responsibility: it reads the user's real config and database. Quit only what your session opened.

When the runtime requests confirmation, the extension shows the request in OMP. Sessions without an interactive UI decline it. The preflight reports a required confirmation as an infrastructure dependency.

## License

MIT
