// Harness descartável: prova a ponte omp-codex-computer-use contra o cua_repl vivo.
// Uso: bun scripts/bridge-smoke.ts ./index.ts FIXED   (± control: git show HEAD:index.ts > /tmp/before.ts)
interface ToolSpec {
  name: string;
  execute: (id: string, params: { code: string; timeout_ms?: number }) => Promise<unknown>;
}
type ExtensionEntry = (pi: unknown) => void;
type Handler = (event: unknown, ctx: unknown) => void;

const [, , modulePath, label] = process.argv;
const SESSION_ID = `smoke-${process.pid}`;

// Proxy que aceita qualquer encadeamento de zod (`z.string().min(1).optional()`):
// o harness não valida parâmetro nenhum, só precisa que registerTool não estoure.
const zodStub = new Proxy(() => zodStub, { get: () => zodStub, apply: () => zodStub }) as unknown as Record<string, never>;

// Import dinâmico obrigatório: o caminho do módulo é escolhido em runtime (argv),
// justamente para rodar o mesmo harness contra a versão corrigida e a de controle.
const mod = (await import(modulePath)) as { default: ExtensionEntry };

// Uma instância = um host `omp --mode rpc-ui`. Instanciar duas vezes com o MESMO
// sessionId é a reciclagem do host que quebrou a sessão real.
function mountHost(): ToolSpec {
  const tools: Record<string, ToolSpec> = {};
  const handlers: Record<string, Handler[]> = {};
  mod.default({
    zod: zodStub,
    registerTool: (spec: ToolSpec) => {
      tools[spec.name] = spec;
    },
    on: (event: string, handler: Handler) => {
      (handlers[event] ??= []).push(handler);
    },
  });
  for (const handler of handlers.session_start ?? []) handler({}, { sessionManager: { getSessionId: () => SESSION_ID } });
  const tool = tools.codex_computer_use;
  if (!tool) throw new Error("tool codex_computer_use não registrada");
  return tool;
}

interface Part {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}
interface Call {
  content: Part[];
  details?: { screenshots: string[] };
  isError?: boolean;
}

const results: string[] = [];
function check(name: string, ok: boolean, detail: string) {
  results.push(ok ? "PASS" : "FAIL");
  console.log(`[${label}] ${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
}

async function js(tool: ToolSpec, code: string, timeout_ms = 30_000): Promise<Call> {
  return (await tool.execute("smoke", { code, timeout_ms })) as Call;
}
function texts(call: Call): string {
  return call.content
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
}

// Host 1 — sessão nova
const host1 = mountHost();
const first = await js(host1, 'globalThis.probe = 41 + 1; nodeRepl.write("probe set");');
check("preambulo na primeira chamada", texts(first).includes("## Computer Use"), `len=${texts(first).length}`);
check("sem aviso de reinicio na primeira", !texts(first).includes("reiniciou"), "silencio");
check("repl grava variavel", texts(first).includes("probe set"), texts(first).slice(-20).replace(/\n/g, " | "));

const second = await js(host1, "nodeRepl.write(String(globalThis.probe));");
check("preambulo NAO repete", !texts(second).includes("## Computer Use"), `len=${texts(second).length}`);
check("variavel sobrevive chamada seguida", texts(second).includes("42"), texts(second).trim());

const shot = await js(host1, 'const a = await cua.getApp("sh.zeron.app"); await a.getScreenshot();', 60_000);
const image = shot.content.find((p) => p.type === "image");
const file = shot.details?.screenshots?.[0] ?? "";
const magic = file ? (await Bun.file(file).bytes()).slice(0, 3) : new Uint8Array();
const isJpeg = magic[0] === 0xff && magic[1] === 0xd8 && magic[2] === 0xff;
const isPng = magic[0] === 0x89 && magic[1] === 0x50;
check(
  "mime casa com o byte",
  !!image && ((isJpeg && image.mimeType === "image/jpeg") || (isPng && image.mimeType === "image/png")),
  `mime=${image?.mimeType} magic=${[...magic].map((b) => b.toString(16)).join("")}`,
);
check("extensao casa com o byte", isJpeg ? file.endsWith(".jpg") : isPng ? file.endsWith(".png") : false, file);

// Host 2 — MESMA sessão de agente, processo/instância nova: a reciclagem do host
const host2 = mountHost();
const afterRecycle = await js(host2, "nodeRepl.write(String(globalThis.probe));", 60_000);
const recycleText = texts(afterRecycle);
check("host reciclado NAO reenvia preambulo", !recycleText.includes("## Computer Use"), `len=${recycleText.length}`);
check("host reciclado ANUNCIA perda de estado", recycleText.includes("cua_repl reiniciou"), recycleText.split("\n")[0].slice(0, 150));
check("estado realmente perdido (controle)", recycleText.includes("undefined"), recycleText.trim().slice(-40).replace(/\n/g, " | "));

const failed = results.filter((r) => r === "FAIL").length;
console.log(`[${label}] === passed: ${results.length - failed} failed: ${failed}`);
process.exit(failed ? 1 : 0);
