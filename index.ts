// @ts-nocheck — o pacote `@oh-my-pi/pi-coding-agent` só existe no runtime do host (não há node_modules neste workspace).
// omp-codex-computer-use — ponte do runtime nativo de Computer Use do Codex (cua_repl) para o OMP.
//
// Origem do runtime: ChatGPT.app + plugin `openai-bundled/unified-computer-use` (stdio MCP, tools `js`/`js_reset`).
// Porte da extensão de Pi `git:github.com/guilhermexp/pi-codex-computer-use` para `ExtensionAPI` do OMP.
// Instalação: link deste diretório em ~/.omp/agent/extensions/ (scripts/link-workspace-skills.sh).
//
// Diferenças conscientes em relação à versão de Pi:
//  - sem fallback com paths/versões hardcoded: sem `.mcp.json` a tool falha dizendo o motivo, não mente;
//  - o preâmbulo de instruções do runtime (~16 KB) vai só na primeira chamada da SESSÃO DE AGENTE,
//    sobrevivendo a reinício do cua_repl (antes ele voltava inteiro a cada reinício);
//  - estado durável por sessão de agente em disco: o host `omp --mode rpc-ui` é RECICLADO no meio da
//    conversa (medido: pids 12020 → 39121 → 1472), e uma flag em memória voltava a zero com ele;
//  - reinício do cua_repl é ANUNCIADO no resultado, em vez de virar `x is not defined` na cara do modelo;
//  - o mimeType da imagem sai do byte, não do rótulo do runtime (ele anuncia PNG e manda JPEG);
//  - todo screenshot é gravado em disco e o path entra no resultado — evidência para o eixo Reality.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Subprocess } from "bun";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const codexHome = process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`;
const PLUGIN_DIR = `${codexHome}/plugins/cache/openai-bundled/unified-computer-use`;
const PREAMBLE_PREFIX = "## Computer Use";
const SHOT_DIR = `${(process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "")}/omp-codex-cua`;
const DEFAULT_TIMEOUT_MS = 30_000;
// Estado que precisa sobreviver à RECICLAGEM DO HOST: o processo `omp --mode
// rpc-ui` que carrega esta extensão é substituído durante a sessão (medido:
// pids 12020 → 39121 → 1472 na mesma conversa), e com ele morrem o cua_repl e
// qualquer flag em memória. Arquivo por sessão de agente, não por processo.
const STATE_DIR = `${(process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "")}/omp-codex-cua`;

interface McpConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  browserUnavailable: boolean;
}

/// Estado da ponte que precisa sobreviver à troca do processo host.
interface BridgeState {
  /// O preâmbulo de ~19 KB do runtime já foi entregue a este contexto.
  preambleSent: boolean;
  /// Quantos REPLs esta sessão de agente já teve. > 1 significa estado perdido.
  boots: number;
}

interface RpcResponse {
  id?: number | string;
  params?: Record<string, unknown>;
  method?: string;
  result?: { thread?: { id?: string }; content?: unknown[]; isError?: boolean };
  error?: { message?: string };
}

interface RenderedResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details?: { screenshots: string[] };
  isError?: boolean;
}

type CuaProcess = Subprocess<"pipe", "pipe", "pipe">;

function asRpcResponse(value: unknown): RpcResponse | null {
  if (!value || typeof value !== "object") return null;
  const msg = value as Record<string, unknown>;
  const id = typeof msg.id === "number" || typeof msg.id === "string" ? msg.id : undefined;
  const method = typeof msg.method === "string" ? msg.method : undefined;
  const result = msg.result && typeof msg.result === "object" ? (msg.result as RpcResponse["result"]) : undefined;
  const error = msg.error && typeof msg.error === "object" ? (msg.error as RpcResponse["error"]) : undefined;
  return { id, method, params: msg.params as RpcResponse["params"], result, error };
}

export function resolveMcpConfig(pluginDir = PLUGIN_DIR, hostEnv = process.env): McpConfig {
  if (!existsSync(pluginDir)) {
    throw new Error(
      `runtime do Codex Computer Use ausente: ${pluginDir} não existe. Instale/abra o ChatGPT.app para materializar o plugin unified-computer-use.`,
    );
  }
  const versions = readdirSync(pluginDir).filter((name) => /^\d+(?:\.\d+)*$/.test(name))
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  for (const version of versions) {
    const mcpPath = `${pluginDir}/${version}/.mcp.json`;
    if (!existsSync(mcpPath)) continue;
    const manifest: unknown = JSON.parse(readFileSync(mcpPath, "utf8"));
    const server = (manifest as { mcpServers?: { cua_repl?: { command?: unknown; args?: unknown; env?: unknown; enabled?: boolean; env_vars?: string[] } } })?.mcpServers?.cua_repl;
    if (server?.enabled === false) throw new Error(`cua_repl está desativado em ${mcpPath}`);
    if (typeof server?.command !== "string" || !Array.isArray(server.args)) continue;
    const env = server.env && typeof server.env === "object" ? (server.env as Record<string, string>) : {};
    const surfaces = env.CUA_REPL_ENABLED_SURFACES?.split(",") ?? ["computer"];
    const browserHostKeys = ["BROWSER_USE_ACCESS_PIPE_PATH", "BROWSER_USE_ACCESS_VERIFYING_IDENTITY"];
    const browserUnavailable = surfaces.includes("browser") &&
      !browserHostKeys.every((key) => server.env_vars?.includes(key) && hostEnv[key]);
    if (browserUnavailable && !surfaces.includes("computer")) {
      throw new Error("O manifesto habilita apenas navegador e esta sessão não recebeu o host de abas.");
    }
    return {
      command: server.command,
      args: server.args.filter((a): a is string => typeof a === "string"),
      env: { ...env, CUA_REPL_ENABLED_SURFACES: browserUnavailable ? "computer" : surfaces.join(",") },
      browserUnavailable,
    };
  }
  throw new Error(`nenhum .mcp.json com mcpServers.cua_repl em ${pluginDir}/<versão>/ (versões: ${versions.join(", ") || "nenhuma"})`);
}

class CuaClient {
  #proc: CuaProcess | null = null;
  #starting: Promise<void> | null = null;
  #nextId = 1;
  #threadId: string | null = null;
  // Map: chaves numéricas criadas e removidas em runtime.
  #pending = new Map<number, (msg: RpcResponse) => void>();
  #stderr = "";
  #exitReason: string | null = null;
  // Chamado depois de cada handshake: um REPL novo nasceu, e quem cuida do
  // estado durável decide se isso é a primeira sessão ou uma perda de estado.
  #onBoot: (exitReason: string | null, browserUnavailable: boolean) => void;
  #confirm: (message: string) => Promise<boolean>;

  constructor(onBoot: (exitReason: string | null, browserUnavailable: boolean) => void, confirm: (message: string) => Promise<boolean>) {
    this.#confirm = confirm;
    this.#onBoot = onBoot;
  }

  #write(msg: unknown) {
    const proc = this.#proc;
    if (!proc) throw new Error("cua_repl não está rodando");
    proc.stdin.write(`${JSON.stringify(msg)}\n`);
    proc.stdin.flush();
  }

  #pump(proc: CuaProcess) {
    const decoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();
    void (async () => {
      for await (const chunk of proc.stderr) this.#stderr = (this.#stderr + stderrDecoder.decode(chunk, { stream: true })).slice(-4000);
    })().catch(() => {});
    void (async () => {
      let buf = "";
      for await (const chunk of proc.stdout) {
        buf += decoder.decode(chunk, { stream: true });
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          const msg = asRpcResponse(parsed);
          if (!msg) continue;
          if ((msg.method === "elicitation/create" || msg.method === "mcpServer/elicitation/request") && msg.id !== undefined) {
            const params = msg.params;
            const schema = params?.requestedSchema as { type?: string; properties?: object } | undefined;
            const fromCua = msg.method === "elicitation/create" ||
              (params?.serverName === "cua_repl" && params?.threadId === this.#threadId);
            const canConfirm = fromCua && (!params?.mode || params.mode === "form") && schema?.type === "object" &&
              !Object.keys(schema.properties ?? {}).length && typeof params?.message === "string";
            const confirmed = canConfirm && await this.#confirm(params.message as string).catch(() => false);
            if (this.#proc === proc) this.#write({
              jsonrpc: "2.0", id: msg.id,
              result: confirmed ? { action: "accept", content: {} } : { action: "decline" },
            });
            continue;
          }
          const resolve = typeof msg.id === "number" && !msg.method ? this.#pending.get(msg.id) : undefined;
          if (resolve) {
            this.#pending.delete(msg.id);
            resolve(msg);
          }
        }
      }
    })()
      .catch(() => {})
      .finally(() => {
        if (this.#proc !== proc) return;
        const signal = proc.signalCode ?? null;
        const code = proc.exitCode ?? null;
        this.#exitReason = `${signal ? `sinal ${signal}` : `exit ${code ?? "?"}`}, stderr: ${this.#stderr || "(vazio)"}`;
        const why = `processo cua_repl terminou (${this.#exitReason})`;
        for (const resolve of this.#pending.values()) resolve({ error: { message: why } });
        this.#pending.clear();
        this.#proc = null;
        this.#starting = null;
      });
  }

  #request(method: string, params: unknown, timeoutMs: number): Promise<RpcResponse> {
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      reject(new Error(`request MCP '${method}' expirou em ${timeoutMs}ms. stderr: ${this.#stderr || "(vazio)"}`));
    }, timeoutMs);
    this.#pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    this.#write({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  async #boot() {
    const config = resolveMcpConfig();
    const cli = config.env.CODEX_CLI_PATH;
    const command = cli ? [cli, "app-server", "--stdio"] : [config.command, ...config.args];
    const proc = Bun.spawn(command, {
      env: cli ? process.env : { ...process.env, ...config.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }) as CuaProcess;
    this.#proc = proc;
    this.#pump(proc);
    this.#threadId = null;
    const clientInfo = { name: "omp-codex-computer-use", version: "1.0.0" };
    if (cli) {
      const init = await this.#request("initialize", { clientInfo }, 30_000);
      if (init.error) throw new Error(init.error.message);
      this.#write({ method: "initialized" });
      const start = await this.#request("thread/start", {
        ephemeral: true, cwd: process.cwd(), sandbox: "read-only",
      }, 120_000);
      const id = start.result?.thread?.id;
      if (!id || start.error) throw new Error(start.error?.message ?? "Codex não criou a sessão do Computer Use");
      this.#threadId = id;
    } else {
      // `initialize` ANTES de `notifications/initialized`: o servidor rmcp recusa a ordem inversa.
      const init = await this.#request(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: { elicitation: { form: {} } },
          clientInfo,
        },
        120_000,
      );
      if (init.error) {
        this.kill();
        throw new Error(`handshake MCP falhou: ${init.error.message ?? "erro sem mensagem"}`);
      }
      this.#write({ jsonrpc: "2.0", method: "notifications/initialized" });
    }
    this.#onBoot(this.#exitReason, config.browserUnavailable);
  }

  async call(name: string, args: unknown, timeoutMs: number): Promise<RpcResponse["result"]> {
    if (!this.#proc || this.#starting) {
      this.#starting ??= this.#boot().catch((err: unknown) => {
        this.kill();
        this.#starting = null;
        throw err;
      });
      await this.#starting;
      this.#starting = null;
    }
    const res = this.#threadId
      ? await this.#request("mcpServer/tool/call", { threadId: this.#threadId, server: "cua_repl", tool: name, arguments: args }, timeoutMs + 10_000)
      : await this.#request("tools/call", { name, arguments: args }, timeoutMs + 10_000);
    if (res.error) throw new Error(res.error.message ?? "erro sem mensagem");
    return res.result;
  }

  kill() {
    const proc = this.#proc;
    if (!proc) return;
    this.#proc = null;
    this.#starting = null;
    for (const resolve of this.#pending.values()) resolve({ error: { message: "conexão Computer Use encerrada" } });
    this.#pending.clear();
    try {
      proc.stdin.end();
      proc.kill();
    } catch {}
  }
}

const RUNTIME_API = `Executa JavaScript no runtime nativo de Computer Use do Codex (cua_repl). O estado do REPL (variáveis, handles de app/tab) persiste entre chamadas enquanto a sessão viver; se ela reiniciar, o resultado diz isso na primeira linha — aí rebinde antes de agir.

Só macOS. Requer ChatGPT.app instalado e permissão de Acessibilidade para "Codex Computer Use.app".

APIs do runtime (superfície completa, medida em 2026-09-18):
- await cua.getState() — apps em execução (displayName + bundle id) e browsers
- await cua.listApps() — todos os apps instalados
- let app = await cua.getApp("Nome" | "bundle.id") — handle do app (lança se preciso) + árvore inicial
- await app.getAXState({ disableDiffing: true }) — árvore de acessibilidade com índice e "ID:" de cada nó
- await app.getScreenshot() — imagem só da janela do app (sem pixel de outra janela por cima); o runtime devolve JPEG mesmo anunciando PNG
- await app.getAXStateAndScreenshot(opts) — árvore + screenshot em uma ida só
- await app.click(indice | [x, y]) — clique por índice de nó (preferir) ou coordenada
- await app.paste("texto", { format }) — insere o texto EXATO (não passa por autocorreção)
- await app.typeText("texto") — tecla por tecla, sujeito à autocorreção do campo
- await app.setValue(indice, "valor") — só em nó "(settable)", e mesmo aí pode virar no-op silencioso (medido no Zeron/GPUI: nenhum erro, valor inalterado) — releia o Value e caia para typeText/paste
- await app.selectText(indice, "texto", { prefix, suffix }) — seleciona trecho dentro do nó
- await app.pressKey("Return" | "super+n" | "super+w" | "Tab")
- await app.scroll(indice | [x, y], "up" | "down", paginas) — páginas, não pixels
- await app.drag([x1, y1], [x2, y2]) — só coordenadas
- await app.performSecondaryAction(indice, "Raise" | "Collapse" | ...)
- nodeRepl.write(texto) — manda texto para o resultado da tool
- await nodeRepl.emitImage(bytes) — manda imagem para o resultado (também gravada em disco)

Concorrência com o usuário (medido, 18 ações com outro app ativo): leitura de AX, screenshot,
click(indice | [x,y]), scroll, drag, pressKey e typeText NÃO ativam o app alvo e NÃO movem o
ponteiro real do usuário — pode rodar enquanto ele usa a máquina. O que rouba o foco é abrir
janela (super+n) ou lançar um app que estava fechado. Screenshot é da janela, não da tela:
janela do usuário por cima não entra no PNG. Mas o runtime só enxerga a janela frontal DO app
alvo — app multi-janela exige trazer a janela certa à frente (performSecondaryAction(indice,
"Raise")) antes de agir.

Cursor do agente: ação por COORDENADA (click([x,y]), scroll([x,y]), drag) faz o serviço desenhar
na tela uma seta sintética no alvo — é o ponteiro que aparece quando o Codex/Pi dirige a máquina.
Ação por índice de nó não desenha nada. O ponteiro real nunca se move em nenhum dos dois casos
(medido: mouse 1134,398 → 1134,398 nas duas famílias de ação; captura sem -C não pega cursor
real, e a seta aparece nos pixels só durante ação por coordenada).

Regras que evitam erro:
- índices de nó expiram a cada ação: chame getAXState e aja na MESMA chamada, nunca reuse índice antigo
- case por "ID:" do nó (ex.: DontSaveButton), não por rótulo — o macOS pode estar em outro idioma
- prefira click(indice) a coordenada: coordenada depende do screenshot mais recente
- assertiva de string literal: paste() (exato, provado) ou setValue() em nó "(settable)"; setValue
  falha calado em app GPUI (Zeron), e typeText sofre autocapitalize (o Editor de Texto transformou
  "omp" em "Omp") — nos dois casos releia o Value depois de escrever
- app com painel modal (ex.: "Abrir" do Editor de Texto) engole super+q: cancele o painel (Escape ou o nó CancelButton) antes de encerrar
- app de iPad/iPhone rodando no Mac (ex.: PPPoker): getApp por bundle id dá "Ambiguous app identifier" e por
  nome ou /Applications/X.app dá "Running application not found" — o macOS executa uma cópia em
  /private/var/folders/.../Wrapper/X.app com o mesmo bundle id. Pegue o caminho do processo no shell com
  \`lsappinfo info -only bundlepath <bundle.id>\` (linha bundle path=) e passe esse caminho ao getApp (o UUID muda ao reabrir o app)
- isolamento é do alvo: o app lê a config/banco real do usuário; nunca transforme dado real em fixture
- feche/encerre só o que esta sessão abriu`;

export default function ompCodexComputerUse(pi: ExtensionAPI) {
  const z = pi.zod;
  let shotSeq = 0;
  // Id da sessão de agente, não do processo: é a única chave que sobrevive à
  // troca do host. `null` até o `session_start` (e no harness de teste) — aí o
  // estado vive só em memória.
  let sessionId: string | null = null;
  let memoryState: BridgeState = { preambleSent: false, boots: 0 };
  let pendingNotice: string | null = null;

  function statePath(): string | null {
    return sessionId ? `${STATE_DIR}/session-${sessionId.replace(/[^\w.-]/g, "_")}.json` : null;
  }

  function readState(): BridgeState {
    const path = statePath();
    if (!path || !existsSync(path)) return memoryState;
    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (raw && typeof raw === "object") {
        const parsed = raw as { preambleSent?: unknown; boots?: unknown };
        return {
          preambleSent: parsed.preambleSent === true,
          boots: typeof parsed.boots === "number" ? parsed.boots : 0,
        };
      }
    } catch {}
    return memoryState;
  }

  function writeState(state: BridgeState) {
    memoryState = state;
    const path = statePath();
    if (!path) return;
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(path, JSON.stringify(state));
    } catch {}
  }

  // Um REPL novo nasceu. Se esta sessão de agente já tinha tido um, o modelo
  // precisa saber ANTES de reusar um handle: foi exatamente assim que um
  // `zeron is not defined` apareceu do nada no meio de uma sessão.
  let sessionUI: { confirm(title: string, message: string): Promise<boolean> } | undefined;
  const client = new CuaClient((exitReason, browserUnavailable) => {
    const state = readState();
    const next = { preambleSent: state.preambleSent, boots: state.boots + 1 };
    writeState(next);
    if (next.boots > 1) {
      const why = exitReason ?? "host do omp reciclado (processo desta extensão é novo)";
      pendingNotice = `[cua_repl reiniciou — ${why}] As variáveis do REPL e os handles de app/tab desta sessão foram perdidos: rebinde com cua.getApp/cua.getTab antes de agir.`;
    }
    if (browserUnavailable) {
      const notice = "Apps nativos habilitados. Esta sessão do OMP não recebeu o host de abas do Codex.";
      pendingNotice = pendingNotice ? `${pendingNotice}\n${notice}` : notice;
    }
  }, async (message) => await sessionUI?.confirm("Computer Use", message) ?? false);

  // O runtime anuncia image/png e manda JPEG; com o rótulo errado o host recusa
  // a imagem inteira. O byte manda.
  function sniffImage(bytes: Buffer): { mimeType: string; ext: string } | null {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mimeType: "image/jpeg", ext: "jpg" };
    if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return { mimeType: "image/png", ext: "png" };
    if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return { mimeType: "image/webp", ext: "webp" };
    if (bytes.length >= 6 && bytes.toString("ascii", 0, 3) === "GIF") return { mimeType: "image/gif", ext: "gif" };
    return null;
  }

  async function render(result: RpcResponse["result"]): Promise<RenderedResult> {
    const content: RenderedResult["content"] = [];
    const screenshots: string[] = [];
    if (pendingNotice) {
      content.push({ type: "text", text: pendingNotice });
      pendingNotice = null;
    }
    for (const raw of result?.content ?? []) {
      if (!raw || typeof raw !== "object") continue;
      const part = raw as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
      if (part.type === "text" && typeof part.text === "string") {
        if (part.text.startsWith(PREAMBLE_PREFIX)) {
          const state = readState();
          if (state.preambleSent) continue;
          writeState({ preambleSent: true, boots: state.boots });
        }
        content.push({ type: "text", text: part.text });
        continue;
      }
      if (part.type === "image" && typeof part.data === "string") {
        const declared = typeof part.mimeType === "string" ? part.mimeType : "image/png";
        const bytes = Buffer.from(part.data, "base64");
        const sniffed = sniffImage(bytes) ?? { mimeType: declared, ext: declared.split("/")[1] || "bin" };
        const path = `${SHOT_DIR}/shot-${process.pid}-${++shotSeq}.${sniffed.ext}`;
        try {
          await Bun.write(path, bytes);
          screenshots.push(path);
        } catch {}
        content.push({ type: "image", data: part.data, mimeType: sniffed.mimeType });
      }
    }
    if (screenshots.length) content.push({ type: "text", text: `screenshots gravados: ${screenshots.join(", ")}` });
    if (!content.length) content.push({ type: "text", text: "(runtime não devolveu conteúdo)" });
    return { content, details: { screenshots }, isError: result?.isError === true };
  }

  pi.registerTool({
    name: "codex_computer_use",
    label: "Codex Computer Use",
    description: RUNTIME_API,
    approval: "exec",
    parameters: z.object({
      code: z.string().describe("Statements JavaScript avaliados no cua_repl"),
      timeout_ms: z.number().int().min(1000).max(300_000).optional().describe("Timeout em ms (padrão 30000)"),
    }),
    async execute(_id: string, params: { code: string; timeout_ms?: number }) {
      const timeout = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
      try {
        return await render(await client.call("js", { code: params.code, timeout_ms: timeout }, timeout));
      } catch (err: unknown) {
        return { content: [{ type: "text", text: `codex_computer_use falhou: ${String(err)}` }], isError: true };
      }
    },
  });

  pi.registerTool({
    name: "codex_computer_use_reset",
    label: "Reset Codex Computer Use",
    description: "Reseta o REPL persistente do cua_repl (limpa variáveis e cache de módulos) sem fechar janelas ou apps.",
    approval: "exec",
    parameters: z.object({}),
    async execute() {
      try {
        const result = await client.call("js_reset", {}, 15_000);
        if (result?.isError) return render(result);
        return { content: [{ type: "text", text: "cua_repl resetado" }] };
      } catch (err: unknown) {
        return { content: [{ type: "text", text: `reset falhou: ${String(err)}` }], isError: true };
      }
    },
  });

  // A chave do estado durável. Sem ela o preâmbulo voltaria inteiro a cada
  // troca do host, e um REPL novo passaria por REPL antigo.
  pi.on("session_start", (_event, ctx) => {
    sessionUI = ctx.hasUI ? ctx.ui : undefined;
    try {
      sessionId = ctx.sessionManager.getSessionId() ?? null;
    } catch {}
  });

  // Sem isso o cua_repl fica órfão quando a sessão encerra.
  pi.on("session_shutdown", () => {
    client.kill();
  });
}
