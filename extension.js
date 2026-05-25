// extension.js — Personal OpenAI Chat for VS Code
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ─── Debug logger ──────────────────────────────────────────────────────────

let debugLogPath = null;
function debug(...args) {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const msg = args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ");
  console.log(`[PAI ${ts}] ${msg}`);
  if (debugLogPath) {
    try { fs.appendFileSync(debugLogPath, `[${ts}] ${msg}\n`); } catch {}
  }
}

function initDebugLog(_context) {
  if (debugLogPath) return;
  const candidates = [
    path.join(os.tmpdir(), "personal-openai-debug.log"),
    path.join(__dirname, "debug.log"),
  ];
  try {
    const gsPath = _context?.globalStorageUri?.fsPath;
    if (gsPath) { fs.mkdirSync(gsPath, { recursive: true }); candidates.unshift(path.join(gsPath, "extension-debug.log")); }
  } catch {}
  for (const p of candidates) {
    try { fs.writeFileSync(p, "", { flag: "a" }); debugLogPath = p; break; } catch {}
  }
  debug(`─── Session start`);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function cfg() {
  return vscode.workspace.getConfiguration("personalOpenAI");
}

function getProviders() {
  return cfg().get("providers") || [];
}

async function getApiKey(context, providerName) {
  return context.secrets.get(`personalOpenAI.apiKey.${providerName}`);
}

async function setApiKey(context, providerName, key) {
  await context.secrets.store(`personalOpenAI.apiKey.${providerName}`, key);
}

async function deleteApiKey(context, providerName) {
  await context.secrets.delete(`personalOpenAI.apiKey.${providerName}`);
}

// ─── OpenAI API call (streaming) ───────────────────────────────────────────

async function* callOpenAI(endpoint, apiKey, model, messages, signal) {
  const config = cfg();
  const body = {
    model,
    messages,
    stream: true,
    temperature: config.get("temperature") ?? 0.2,
    max_tokens: config.get("maxTokens") ?? 8192,
  };

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const url = endpoint.replace(/\/$/, "") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "data: [DONE]") continue;
      if (trimmed.startsWith("data: ")) {
        try {
          const json = JSON.parse(trimmed.slice(6));
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // skip malformed chunk
        }
      }
    }
  }
}

/**
 * OpenAI streaming with tool-call support.
 * Yields { type: "text", text: string } | { type: "tool_calls", calls: array }
 */
async function* callOpenAIWithTools(endpoint, apiKey, model, messages, signal, extraBody = {}) {
  const t0 = Date.now();
  const config = cfg();
  // Hard cap: never send more than 32768 max_tokens to prevent runaway generation
  const maxTokens = Math.min(config.get("maxTokens") ?? 8192, 32768);
  const body = {
    model,
    messages,
    stream: true,
    temperature: config.get("temperature") ?? 0.2,
    max_tokens: maxTokens,
    ...extraBody,
  };

  // If tools are present, request a tool_choice that prevents the model
  // from generating endless reasoning before calling tools
  if (body.tools?.length && !body.tool_choice) {
    body.tool_choice = "auto";
  }

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const url = endpoint.replace(/\/$/, "") + "/chat/completions";
  debug(`→ POST model=${model} msgs=${messages.length} tools=${body.tools?.length || 0} max_tokens=${body.max_tokens}`);

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  const ttfb = Date.now() - t0;
  debug(`← HTTP ${res.status} TTFB=${ttfb}ms ct=${res.headers.get("content-type")}`);

  if (!res.ok) {
    const text = await res.text();
    debug(`❌ HTTP ${res.status} body=${text.slice(0, 300)}`);
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  // Accumulate tool calls across streaming deltas
  const toolCallsAcc = {}; // index -> { id, name, arguments }
  let chunkCount = 0;
  let lastChunkTime = Date.now();
  const STREAM_TIMEOUT_MS = 120_000; // 2 min max between chunks

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const now = Date.now();
    if (now - lastChunkTime > STREAM_TIMEOUT_MS) {
      debug(`⚠ stream stalled ${now - lastChunkTime}ms → abort`);
      reader.cancel();
      throw new Error("Stream timeout: no data for 120s");
    }
    lastChunkTime = now;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "data: [DONE]") continue;
      if (!trimmed.startsWith("data: ")) continue;
      try {
        const json = JSON.parse(trimmed.slice(6));
        const choice = json.choices?.[0];
        if (!choice) continue;

        // Text delta (content OR reasoning_content)
        const deltaText = choice.delta?.content;
        const reasoningText = choice.delta?.reasoning_content;
        if (deltaText) {
          yield { type: "text", text: deltaText };
        }
        if (reasoningText) {
          // DeepSeek: yield reasoning separately for caching later
          yield { type: "reasoning", text: reasoningText };
        }

        // Tool call deltas (OpenAI format: array of tool_call deltas)
        const toolDeltas = choice.delta?.tool_calls;
        if (toolDeltas) {
          for (const tc of toolDeltas) {
            const idx = tc.index ?? 0;
            if (!toolCallsAcc[idx]) {
              toolCallsAcc[idx] = { id: "", name: "", arguments: "" };
            }
            if (tc.id) toolCallsAcc[idx].id = tc.id;
            if (tc.function?.name) toolCallsAcc[idx].name += tc.function.name;
            if (tc.function?.arguments) toolCallsAcc[idx].arguments += tc.function.arguments;
          }
        }

        // finish_reason "tool_calls" → emit accumulated tool calls
        if (choice.finish_reason === "tool_calls") {
          const calls = Object.values(toolCallsAcc).filter((c) => c.id && c.name);
          if (calls.length > 0) {
            const callNames = calls.map(c => `${c.name}(${(c.arguments || "").slice(0, 80)})`).join(",");
            debug(`🔧 tool_calls: ${callNames} (${chunkCount} chunks, ${Date.now() - t0}ms total)`);
            yield { type: "tool_calls", calls };
            // Reset accumulator to prevent duplicate emission in fallback
            for (const key of Object.keys(toolCallsAcc)) delete toolCallsAcc[key];
          }
        }

        chunkCount++;
        lastChunkTime = Date.now();
      } catch {
        // skip malformed chunk
      }
    }
  }

  debug(`✓ stream done: ${chunkCount} chunks, ${Date.now() - t0}ms total`);

  // Fallback: if stream ended without explicit finish_reason, emit any accumulated tool calls
  const pending = Object.values(toolCallsAcc).filter((c) => c.id && c.name);
  if (pending.length > 0) {
    yield { type: "tool_calls", calls: pending };
  }
}

// Non-streaming version for simple requests (e.g. model list)
async function callOpenAISimple(endpoint, apiKey, path, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const url = endpoint.replace(/\/$/, "") + path;
  const res = await fetch(url, { headers, ...options });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Capability detection ──────────────────────────────────────────────────

const TOOL_ERR_RE = /(does\s*not\s*support\s*(tool|function)|tool[_\s]?(call|use)\s*not\s*supported|no\s*tool\s*support|function[_\s]?calling\s*not\s*supported)/i;

function isOpenRouterEndpoint(ep) {
  return /openrouter\.ai/i.test(ep);
}
function isOllamaEndpoint(ep) {
  return /:11434(\/|$)|\/ollama(\/|$)/i.test(ep);
}

function getDetectionTimeout(override) {
  if (override && override > 0) return override;
  return cfg().get("detection.timeoutMs") || 30000;
}
function getDetectionConcurrency(endpoint, override) {
  if (override && override > 0) return override;
  const configured = cfg().get("detection.concurrency") || 0;
  if (configured > 0) return configured;
  // Gateways (mammon-ai, OpenRouter, etc.) handle parallel requests well even on localhost
  if (isOpenRouterEndpoint(endpoint)) return 8;
  return 6;
}

// Parse OpenRouter /models response: each entry has supported_parameters[] and architecture
function parseOpenRouterCaps(data) {
  const out = {};
  for (const m of (data?.data || [])) {
    if (!m?.id) continue;
    const sp = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    const inputModalities = m.architecture?.input_modalities || [];
    out[m.id] = {
      toolCalling: sp.includes("tools") || sp.includes("tool_choice"),
      imageInput: inputModalities.includes("image"),
      source: "openrouter",
    };
  }
  return out;
}

// Generic /v1/models capability parser — any gateway that returns a `capabilities`
// array per model (mammon-ai, OpenWebUI, etc.) gets treated as authoritative.
// Returns { [id]: caps } only for entries that actually carry a capabilities field.
function parseGatewayCaps(data) {
  const out = {};
  for (const m of (data?.data || data?.models || [])) {
    const id = m?.id;
    if (!id) continue;
    const caps = m.capabilities;
    if (!Array.isArray(caps)) continue;
    out[id] = {
      toolCalling: caps.includes("tools") || caps.includes("function_calling"),
      imageInput: caps.includes("vision") || caps.includes("image"),
      source: "gateway",
    };
  }
  return out;
}

// Ollama: POST /api/show → { capabilities: ["tools", "vision", ...] }
async function detectOllamaCaps(endpoint, modelId, signal, timeoutMs = 10000) {
  // Strip trailing /v1 for native ollama API
  const base = endpoint.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
  try {
    const res = await fetch(base + "/api/show", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelId }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = await res.json();
    const caps = Array.isArray(j.capabilities) ? j.capabilities : [];
    if (!caps.length) return null;
    return {
      toolCalling: caps.includes("tools"),
      imageInput: caps.includes("vision"),
      source: "ollama",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Probe: send a 1-token request with a dummy tool. If the server rejects with
// a "no tool support" 400, the model doesn't support tools. Otherwise assume yes.
// Returns { toolCalling, imageInput, source } | { source: "timeout" } | null
async function probeToolSupport(endpoint, apiKey, modelId, signal, timeoutMs = 30000) {
  const body = {
    model: modelId,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
    stream: false,
    tools: [{
      type: "function",
      function: {
        name: "noop",
        description: "noop",
        parameters: { type: "object", properties: {} },
      },
    }],
    tool_choice: "auto",
  };
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const url = endpoint.replace(/\/$/, "") + "/chat/completions";
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    clearTimeout(timer);
    if (res.status === 400) {
      const text = await res.text().catch(() => "");
      if (TOOL_ERR_RE.test(text)) return { toolCalling: false, imageInput: false, source: "probe" };
      return { toolCalling: true, imageInput: false, source: "probe" };
    }
    if (res.ok) return { toolCalling: true, imageInput: false, source: "probe" };
    return null; // 401/403/5xx → unknown
  } catch {
    if (timedOut) return { source: "timeout" };
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Limit concurrency for probes
async function mapWithConcurrency(items, concurrency, mapper) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await mapper(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

// Detect capabilities for a list of models against an endpoint.
// Returns: { [modelId]: { toolCalling, imageInput, source } }
// Models that timed out get { source: "timeout" } so the UI can show a retry badge.
// onProgress(done, total, currentModel) is called for each model resolved.
async function detectCapabilities(endpoint, apiKey, models, onProgress, opts = {}) {
  const result = {};
  const total = models.length;
  let done = 0;
  const tick = (m) => { done++; try { onProgress?.(done, total, m); } catch {} };

  const timeoutMs = getDetectionTimeout(opts.timeoutMs);
  const concurrency = getDetectionConcurrency(endpoint, opts.concurrency);
  debug(`[caps] detect endpoint=${endpoint} models=${total} timeout=${timeoutMs}ms concurrency=${concurrency}`);

  // Step 1: bulk metadata (single /models fetch, used by OpenRouter and any gateway
  // that exposes a `capabilities` array per model — mammon-ai, OpenWebUI, etc.)
  // Caller can pass `bulkData` to avoid re-fetching.
  let bulkData = opts.bulkData;
  if (!bulkData) {
    try { bulkData = await callOpenAISimple(endpoint, apiKey, "/models"); } catch {}
  }
  if (bulkData) {
    if (isOpenRouterEndpoint(endpoint)) {
      Object.assign(result, parseOpenRouterCaps(bulkData));
    }
    // Generic capabilities field — always try, takes precedence over OpenRouter
    // only if it actually contains a capabilities array (parseGatewayCaps skips otherwise)
    const gw = parseGatewayCaps(bulkData);
    for (const [m, c] of Object.entries(gw)) {
      result[m] = c; // gateway is authoritative when it provides metadata
    }
    for (const m of models) if (result[m]) tick(m);
  }

  const remaining = models.filter((m) => !result[m]);
  const ollama = isOllamaEndpoint(endpoint);

  // Step 2: per-model detection (Ollama /api/show, then probe fallback)
  await mapWithConcurrency(remaining, concurrency, async (m) => {
    let caps = null;
    // Ollama /api/show is fast (no inference) — try first to skip the expensive probe
    if (ollama) caps = await detectOllamaCaps(endpoint, m, undefined, 10000);
    if (!caps) caps = await probeToolSupport(endpoint, apiKey, m, undefined, timeoutMs);
    // Always record an entry so UI knows we tried — even on probe failure
    result[m] = caps || { source: "error" };
    tick(m);
  });

  return result;
}

// Merge fresh detection into the provider's modelCapabilities, preserving manual overrides.
function mergeCapabilities(existing, detected) {
  const out = { ...(existing || {}) };
  for (const [m, caps] of Object.entries(detected)) {
    const prev = out[m];
    // Keep manual overrides
    if (prev?.source === "manual") continue;
    out[m] = caps;
  }
  return out;
}

// Persist a single-model capability change (used by runtime fallback)
async function patchModelCapability(providerName, modelId, patch) {
  const list = getProviders();
  const idx = list.findIndex((p) => p.name === providerName);
  if (idx < 0) return;
  const p = list[idx];
  const caps = { ...(p.modelCapabilities || {}) };
  caps[modelId] = { ...(caps[modelId] || {}), ...patch };
  list[idx] = { ...p, modelCapabilities: caps };
  await cfg().update("providers", list, vscode.ConfigurationTarget.Global);
  debug(`[caps] persisted ${providerName}/${modelId} → ${JSON.stringify(patch)}`);
}

// Resolve effective capabilities for a model, falling back to provider defaults.
function resolveCaps(provider, modelId) {
  const perModel = provider.modelCapabilities?.[modelId];
  return {
    toolCalling: perModel?.toolCalling ?? provider.toolCalling ?? true,
    imageInput:  perModel?.imageInput  ?? provider.imageInput  ?? false,
    source:      perModel?.source      ?? "default",
  };
}

// ─── Commands ──────────────────────────────────────────────────────────────

// Opens a persistent WebView form — no input box that disappears on focus loss
async function cmdConfigureProvider(context) {
  const panel = vscode.window.createWebviewPanel(
    "personalOpenAIConfig",
    "Configure Provider",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const providers = getProviders();
  panel.webview.html = getConfigHtml(providers);

  panel.webview.onDidReceiveMessage(async (msg) => {
    // ── Fetch models from endpoint ──
    if (msg.type === "fetchModels") {
      const apiKey = msg.apiKey || (await getApiKey(context, msg.name)) || "";
      try {
        const data = await callOpenAISimple(msg.endpoint, apiKey, "/models");
        const models = (data.data || data.models || [])
          .map((m) => m.id || m)
          .filter(Boolean);
        panel.webview.postMessage({ type: "models", models });
        // Auto-kick capability detection right after listing — reuse the response
        // so gateways exposing `capabilities` (mammon-ai, OpenWebUI, OpenRouter)
        // are read directly without a second roundtrip or any probe.
        if (models.length) {
          panel.webview.postMessage({ type: "capsProgress", done: 0, total: models.length });
          try {
            const caps = await detectCapabilities(msg.endpoint, apiKey, models, (done, total, m) => {
              panel.webview.postMessage({ type: "capsProgress", done, total, current: m });
            }, { bulkData: data });
            panel.webview.postMessage({ type: "capsResult", capabilities: caps });
          } catch (e) {
            panel.webview.postMessage({ type: "capsError", message: e.message });
          }
        }
      } catch (e) {
        panel.webview.postMessage({ type: "fetchError", message: e.message });
      }
      return;
    }

    // ── Manual re-detect for the currently edited model list ──
    if (msg.type === "detectCapabilities") {
      const apiKey = msg.apiKey || (await getApiKey(context, msg.name)) || "";
      try {
        panel.webview.postMessage({ type: "capsProgress", done: 0, total: msg.models.length });
        const opts = {};
        if (msg.timeoutMs) opts.timeoutMs = msg.timeoutMs;
        if (msg.concurrency) opts.concurrency = msg.concurrency;
        const caps = await detectCapabilities(msg.endpoint, apiKey, msg.models, (done, total, m) => {
          panel.webview.postMessage({ type: "capsProgress", done, total, current: m });
        }, opts);
        panel.webview.postMessage({ type: "capsResult", capabilities: caps });
      } catch (e) {
        panel.webview.postMessage({ type: "capsError", message: e.message });
      }
      return;
    }

    // ── Save provider ──
    if (msg.type === "save") {
      const { name, endpoint, apiKey, models, defaultModel,
              toolCalling, imageInput, contextWindow, modelCapabilities, editingName } = msg;

      if (apiKey.trim()) {
        await setApiKey(context, name.trim(), apiKey.trim());
      }

      // Preserve existing per-model caps merged with any incoming caps from the webview
      const currentProviders = getProviders();
      const existing = editingName ? currentProviders.find((p) => p.name === editingName) : null;
      const mergedCaps = { ...(existing?.modelCapabilities || {}), ...(modelCapabilities || {}) };
      // Drop entries for models no longer in the list
      const kept = {};
      for (const m of models) if (mergedCaps[m]) kept[m] = mergedCaps[m];

      const updated = {
        name: name.trim(),
        endpoint: endpoint.trim(),
        models: models.filter(Boolean),
        defaultModel: defaultModel || models[0] || "",
        toolCalling,
        imageInput,
        contextWindow: Number(contextWindow) || 128000,
        modelCapabilities: kept,
      };

      const list = editingName
        ? currentProviders.map((p) => (p.name === editingName ? updated : p))
        : [...currentProviders, updated];

      await cfg().update("providers", list, vscode.ConfigurationTarget.Global);
      panel.webview.postMessage({ type: "saved", provider: updated, editingName });
      return;
    }

    // ── Delete provider ──
    if (msg.type === "delete") {
      await deleteApiKey(context, msg.name);
      // Always re-read providers from config to avoid stale closure data
      const currentProviders = getProviders();
      const list = currentProviders.filter((p) => p.name !== msg.name);
      await cfg().update("providers", list, vscode.ConfigurationTarget.Global);
      panel.webview.postMessage({ type: "deleted", name: msg.name });
      return;
    }
  });
}

async function cmdPickModel(context) {
  const providers = getProviders();
  if (!providers.length) {
    vscode.window.showWarningMessage(
      "No providers configured. Run Personal OpenAI: Configure Provider first."
    );
    return;
  }

  const items = providers.flatMap((p) =>
    (p.models || []).map((m) => {
      const caps = resolveCaps(p, m);
      const badges = [];
      if (caps.toolCalling) badges.push("🔧 tools");
      if (caps.imageInput) badges.push("🖼 vision");
      const detail = badges.length ? badges.join(" · ") : "text-only";
      return {
        label: m,
        description: `${p.name}  ·  ${detail}`,
        provider: p,
        model: m,
      };
    })
  );

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Select active model",
  });
  if (!pick) return;

  await cfg().update(
    "activeProvider",
    pick.provider.name,
    vscode.ConfigurationTarget.Global
  );
  await cfg().update(
    "activeModel",
    pick.model,
    vscode.ConfigurationTarget.Global
  );
  vscode.window.showInformationMessage(
    `Active model: ${pick.label} (${pick.provider.name})`
  );
}

async function cmdTestConnection(context) {
  const providers = getProviders();
  if (!providers.length) {
    vscode.window.showWarningMessage("No providers configured.");
    return;
  }

  const pick = await vscode.window.showQuickPick(
    providers.map((p) => ({ label: p.name, provider: p })),
    { placeHolder: "Select provider to test" }
  );
  if (!pick) return;

  const { provider } = pick;
  const apiKey = await getApiKey(context, provider.name);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Testing ${provider.name}…`,
    },
    async () => {
      try {
        await callOpenAISimple(provider.endpoint, apiKey, "/models");
        vscode.window.showInformationMessage(
          `✅ ${provider.name} is reachable.`
        );
      } catch (e) {
        vscode.window.showErrorMessage(
          `❌ ${provider.name} failed: ${e.message}`
        );
      }
    }
  );
}

async function cmdClearApiKey(context) {
  const providers = getProviders();
  if (!providers.length) {
    vscode.window.showWarningMessage("No providers configured.");
    return;
  }

  const pick = await vscode.window.showQuickPick(
    providers.map((p) => p.name),
    { placeHolder: "Select provider to clear API key" }
  );
  if (!pick) return;

  await deleteApiKey(context, pick);
  vscode.window.showInformationMessage(`API key for "${pick}" deleted.`);
}

// ─── Chat Panel (WebView) ──────────────────────────────────────────────────

let chatPanel = null;

async function cmdOpenChat(context) {
  if (chatPanel) {
    chatPanel.reveal(vscode.ViewColumn.Two);
    return;
  }

  chatPanel = vscode.window.createWebviewPanel(
    "personalOpenAIChat",
    "Personal OpenAI Chat",
    vscode.ViewColumn.Two,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  chatPanel.onDidDispose(() => {
    chatPanel = null;
  });

  chatPanel.webview.html = getChatHtml();

  // Inject provider list on load
  const providers = getProviders();
  chatPanel.webview.postMessage({ type: "providers", providers });

  // Handle messages from webview
  const abortControllers = new Map();

  chatPanel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === "send") {
      const { id, providerName, model, history } = msg;
      const providers = getProviders();
      const provider = providers.find((p) => p.name === providerName);
      if (!provider) {
        chatPanel?.webview.postMessage({
          type: "error",
          id,
          text: "Provider not found.",
        });
        return;
      }
      const apiKey = await getApiKey(context, providerName);
      const systemPrompt =
        cfg().get("systemPrompt") ||
        "You are a helpful coding assistant inside VS Code.";
      const messages = [
        { role: "system", content: systemPrompt },
        ...history,
      ];

      const ac = new AbortController();
      abortControllers.set(id, ac);
      chatPanel?.webview.postMessage({ type: "start", id });

      try {
        for await (const chunk of callOpenAI(
          provider.endpoint,
          apiKey,
          model,
          messages,
          ac.signal
        )) {
          chatPanel?.webview.postMessage({ type: "chunk", id, text: chunk });
        }
        chatPanel?.webview.postMessage({ type: "done", id });
      } catch (e) {
        if (e.name !== "AbortError") {
          chatPanel?.webview.postMessage({
            type: "error",
            id,
            text: e.message,
          });
        }
      } finally {
        abortControllers.delete(id);
      }
    }

    if (msg.type === "abort") {
      abortControllers.get(msg.id)?.abort();
      abortControllers.delete(msg.id);
    }

    if (msg.type === "refreshProviders") {
      const providers = getProviders();
      chatPanel?.webview.postMessage({ type: "providers", providers });
    }
  });
}

// ─── Language Model Provider (Copilot integration) ─────────────────────────

function registerLanguageModels(context) {
  const _onDidChange = new vscode.EventEmitter();
  let disposable = null;

  // DeepSeek requires reasoning_content in history for tool_calls msgs
  const reasoningCache = new Map(); // toolCallId → { text, timestamp }
  const RC_MAX = 50;
  const RC_TTL = 5 * 60 * 1000;
  function pruneRC() {
    const now = Date.now();
    for (const [k, v] of reasoningCache) {
      if (now - v.timestamp > RC_TTL) reasoningCache.delete(k);
    }
    if (reasoningCache.size > RC_MAX) {
      [...reasoningCache.keys()].slice(0, reasoningCache.size - RC_MAX).forEach(k => reasoningCache.delete(k));
    }
  }

  /** Build the list of LanguageModelChatInformation objects from current config */
  function buildModelList() {
    const providers = getProviders();
    /** @type {vscode.LanguageModelChatInformation[]} */
    const models = [];
    for (const provider of providers) {
      for (const modelId of provider.models || []) {
        const caps = resolveCaps(provider, modelId);
        const badge = caps.toolCalling ? " 🔧" : "";
        models.push({
          id: `${provider.name}/${modelId}`,
          name: `${provider.name} / ${modelId}${badge}`,
          vendor: "personal-openai",
          family: provider.name,
          version: "1.0",
          maxInputTokens: provider.contextWindow ?? 128000,
          maxOutputTokens: cfg().get("maxTokens") ?? 4096,
          capabilities: {
            toolCalling: caps.toolCalling,
            imageInput: caps.imageInput,
          },
        });
      }
    }
    return models;
  }

  const provider = {
    onDidChangeLanguageModelChatInformation: _onDidChange.event,

    async provideLanguageModelChatInformation(_options, _token) {
      return buildModelList();
    },

    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
      const tReqStart = Date.now();
      // model.id is  "providerName/modelId"
      const slash = model.id.indexOf("/");
      const providerName = slash >= 0 ? model.id.slice(0, slash) : model.family;
      const modelId = slash >= 0 ? model.id.slice(slash + 1) : model.id;

      const providers = getProviders();
      const cfgProvider = providers.find((p) => p.name === providerName);
      if (!cfgProvider) {
        throw new Error(`Provider "${providerName}" not found. Reconfigure providers.`);
      }

      // ── Respect per-model toolCalling setting (falls back to provider default) ──
      const resolved = resolveCaps(cfgProvider, modelId);
      const enableTools = resolved.toolCalling !== false;

      debug(`[lm] REQ provider=${providerName} model=${modelId} msgs=${messages.length} tools=${enableTools ? options.tools?.length || 0 : "off"}`);

      const apiKey = await getApiKey(context, providerName);
      const defaultSystemPrompt = "You are a helpful coding assistant inside VS Code.";
      const systemPrompt =
        cfg().get("systemPrompt") ||
        defaultSystemPrompt;

      // ── Enhanced system prompt when tools are enabled ──────────────
      const toolSystemPrompt = enableTools
        ? `\n\nYou have access to tools for file editing, terminal commands, code search, and web browsing. CRITICAL RULES:
1. ALWAYS provide ALL required parameters. Study each tool's schema carefully. Never call a tool with empty input {} or missing required fields.
2. The most important tool is "manage_todo_list" — it REQUIRES a "todoList" array with objects having "id", "title", and "status" fields. Example: {"todoList":[{"id":1,"title":"Task name","status":"in-progress"}]}
3. If a tool returns an error, read the error message, UNDERSTAND what went wrong, and FIX your input on the next attempt. Never retry with identical input.
4. If a tool returns a short status (e.g. "No browser pages open"), the tool completed successfully. Move on.
5. After 2 failed attempts with any tool, GIVE UP and provide your best answer in plain text.
6. When done, output a clear FINAL ANSWER in plain text — do NOT keep calling tools forever.
7. Before calling ANY tool, double-check: are ALL required parameters present and valid? If unsure, ask the user instead of guessing.`
        : "";

      // ── Map incoming messages to OpenAI format ──────────────────────
      const tMapStart = Date.now();
      const openaiMessages = [
        { role: "system", content: systemPrompt + toolSystemPrompt },
      ];

      for (const msg of messages) {
        if (typeof msg.content === "string") {
          openaiMessages.push({
            role: msg.role === 1 ? "user" : "assistant",
            content: msg.content,
          });
          continue;
        }

        // If tools disabled: flatten everything to plain text, no tool history
        if (!enableTools) {
          const text = msg.content
            .map((p) => (p && typeof p.value === "string" ? p.value : ""))
            .filter(Boolean)
            .join("\n");
          openaiMessages.push({
            role: msg.role === 1 ? "user" : "assistant",
            content: text || "",
          });
          continue;
        }

        // Content is an array of parts: LanguageModelTextPart,
        // LanguageModelToolCallPart, LanguageModelToolResultPart, etc.
        const textParts = [];
        const toolCalls = [];
        const toolResults = [];

        for (const part of msg.content) {
          if (!part) continue;

          // Duck-typing: parts with `name` + `input` are tool calls (assistant)
          if (typeof part.name === "string" && part.input !== undefined) {
            toolCalls.push({
              id: part.callId || "",
              type: "function",
              function: {
                name: part.name,
                arguments: typeof part.input === "string"
                  ? part.input
                  : JSON.stringify(part.input),
              },
            });
            debug(`[lm]   ← tool_call id=${part.callId} name=${part.name} input=${JSON.stringify(part.input).slice(0, 100)}`);
          } else if (typeof part.callId === "string") {
            // LanguageModelToolResultPart (user)
            let resultContent = "";
            if (Array.isArray(part.content)) {
              resultContent = part.content
                .map((p) => (typeof p === "string" ? p : p?.value || ""))
                .join("");
            } else if (typeof part.content === "string") {
              resultContent = part.content;
            } else if (typeof part.value === "string") {
              resultContent = part.value;
            }
            toolResults.push({ callId: part.callId, content: resultContent });
            debug(`[lm]   ← tool_result id=${part.callId} content_len=${resultContent.length} preview="${resultContent.slice(0, 80)}"`);
          } else if (typeof part.value === "string") {
            // LanguageModelTextPart
            textParts.push(part.value);
          }
        }

        const hasText = textParts.length > 0;
        const hasToolCalls = toolCalls.length > 0;
        const hasToolResults = toolResults.length > 0;

        // ── Assistant message with tool_calls ──────────────────────
        if (hasToolCalls) {
          // Inject cached reasoning_content (DeepSeek requires this)
          let rc = "";
          for (const tc of toolCalls) {
            const c = reasoningCache.get("tool:" + tc.id) ?? reasoningCache.get(tc.id);
            if (c) { rc = c.text; break; }
          }
          const entry = {
            role: "assistant",
            content: hasText ? textParts.join("\n") : "",
            tool_calls: toolCalls,
          };
          if (rc) entry.reasoning_content = rc;
          openaiMessages.push(entry);
          continue;
        }

        // ── Text-only message (user or assistant) ──────────────────
        if (hasText) {
          openaiMessages.push({
            role: msg.role === 1 ? "user" : "assistant",
            content: textParts.join("\n"),
          });
        }

        // ── Tool results → emit as "tool" role messages directly ───
        // CRITICAL: Do NOT emit a user message between assistant tool_calls
        // and tool responses. OpenAI requires: assistant(tool_calls) → tool → tool → ...
        for (const tr of toolResults) {
          openaiMessages.push({
            role: "tool",
            tool_call_id: tr.callId,
            content: tr.content,
          });
          debug(`[lm]   → tool msg id=${tr.callId} content_len=${tr.content.length}`);
        }
      }

      // ── Build tool definitions from options ────────────────────────
      const extraBody = {};
      if (enableTools && options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
        extraBody.tools = options.tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description || "",
            parameters: t.inputSchema || { type: "object", properties: {} },
          },
        }));

        if (options.toolMode) {
          const mode = typeof options.toolMode === "number"
            ? options.toolMode
            : (options.toolMode?.mode ?? options.toolMode);
          if (mode === 2 || mode === "required") extraBody.tool_choice = "required";
          else extraBody.tool_choice = "auto";
        }
      }

      // ── Tool call loop detection ──────────────────────────────────
      // Only triggers when the *recent* tool calls are empty/invalid.
      // Repeating a valid call (e.g. read_file on the same path after "continue")
      // is NOT a loop — previously we scanned the entire history and disabled
      // tools forever as soon as any call appeared 3 times.
      const toolCallHistory = [];
      for (const msg of messages) {
        const parts = Array.isArray(msg.content) ? msg.content : [];
        for (const part of parts) {
          if (typeof part.name === "string" && part.input !== undefined) {
            const inputStr = typeof part.input === "string" ? part.input : JSON.stringify(part.input);
            toolCallHistory.push({ name: part.name, input: inputStr });
          }
        }
      }

      // Sliding window: look at the last N tool calls only.
      const LOOP_WINDOW = 6;
      const LOOP_THRESHOLD = 4; // need ≥4 bad-recent calls to trigger
      const recent = toolCallHistory.slice(-LOOP_WINDOW);

      const isEmptyOrInvalid = (inputStr) => {
        try {
          const o = JSON.parse(inputStr);
          return !o || typeof o !== "object" || Object.keys(o).length === 0;
        } catch {
          return true; // unparseable args = bad
        }
      };

      const recentEmpty = recent.filter((tc) => isEmptyOrInvalid(tc.input)).length;

      // Detect identical-call repetition within the window only
      const recentFreq = {};
      for (const tc of recent) {
        const sig = tc.name + "::" + tc.input;
        recentFreq[sig] = (recentFreq[sig] || 0) + 1;
      }
      const recentMaxRepeat = Math.max(0, ...Object.values(recentFreq));

      // Trigger only if BOTH conditions hold within the recent window:
      // many of them are empty/invalid AND a single signature dominates.
      // This avoids killing tools when the model legitimately re-reads a file
      // multiple times across a long task.
      const loopDetected =
        recent.length >= LOOP_THRESHOLD &&
        recentEmpty >= LOOP_THRESHOLD &&
        recentMaxRepeat >= LOOP_THRESHOLD;

      if (loopDetected && enableTools && extraBody.tools?.length) {
        debug(`[lm] ⚠ TOOL LOOP DETECTED — window=${recent.length} empty=${recentEmpty} maxRepeat=${recentMaxRepeat} → forcing text response`);
        // Inject a strong instruction to stop using tools
        openaiMessages.push({
          role: "user",
          content: "SYSTEM OVERRIDE: You have repeatedly called tools with invalid or empty arguments. STOP calling tools immediately. Provide your final answer as plain text without any tool calls. Do NOT call any function."
        });
        // Disable tools entirely for this request so the model CAN'T call them
        delete extraBody.tools;
        delete extraBody.tool_choice;
      } else if (recent.length > 0) {
        debug(`[lm] loop-check: window=${recent.length} empty=${recentEmpty} maxRepeat=${recentMaxRepeat} → ok`);
      }

      // ── Stream from OpenAI ─────────────────────────────────────────
      const tMapEnd = Date.now();
      const toolMsgCount = openaiMessages.filter(m => m.role === "tool").length;
      const assistantTcCount = openaiMessages.filter(m => m.tool_calls?.length).length;
      debug(`[lm] mapped ${messages.length}→${openaiMessages.length} msgs (${toolMsgCount} tool, ${assistantTcCount} assistant_tc) in ${tMapEnd - tMapStart}ms`);

      const ac = new AbortController();
      token.onCancellationRequested(() => ac.abort());

      const tStreamStart = Date.now();
      let streamReasoning = "";
      const streamToolCallIds = [];

      const runStream = async (body) => {
        for await (const chunk of callOpenAIWithTools(
          cfgProvider.endpoint,
          apiKey,
          modelId,
          openaiMessages,
          ac.signal,
          body
        )) {
          if (chunk.type === "text") {
            progress.report(new vscode.LanguageModelTextPart(chunk.text));
          } else if (chunk.type === "reasoning") {
            streamReasoning += chunk.text;
          } else if (chunk.type === "tool_calls") {
            for (const tc of chunk.calls) {
              let parsedInput;
              try {
                parsedInput = JSON.parse(tc.arguments || "{}");
              } catch {
                parsedInput = {};
              }
              progress.report(
                new vscode.LanguageModelToolCallPart(tc.id, tc.name, parsedInput)
              );
              streamToolCallIds.push(tc.id);
            }
          }
        }
      };

      try {
        await runStream(extraBody);
      } catch (err) {
        const msg = String(err?.message || "");
        const hadTools = !!extraBody.tools?.length;
        // Runtime fallback: model rejects tools at the API level → retry without tools and persist
        if (hadTools && TOOL_ERR_RE.test(msg)) {
          debug(`[lm] ⚠ tool rejection detected for ${providerName}/${modelId} → persisting toolCalling=false and retrying without tools`);
          await patchModelCapability(providerName, modelId, {
            toolCalling: false,
            imageInput: resolved.imageInput,
            source: "runtime",
          });
          _onDidChange.fire(); // refresh VS Code's model list
          vscode.window.showWarningMessage(
            `Model "${modelId}" does not support tools — disabled tool calling and retrying.`
          );
          const retryBody = { ...extraBody };
          delete retryBody.tools;
          delete retryBody.tool_choice;
          await runStream(retryBody);
        } else {
          throw err;
        }
      }
      // Cache reasoning for DeepSeek history injection
      if (streamReasoning && streamToolCallIds.length > 0) {
        for (const id of streamToolCallIds) {
          reasoningCache.set("tool:" + id, { text: streamReasoning, timestamp: Date.now() });
        }
        pruneRC();
      }
      debug(`[lm] stream done in ${Date.now() - tStreamStart}ms total, req total=${Date.now() - tReqStart}ms`);
    },

    async provideTokenCount(model, text, _token) {
      if (typeof text === "string") {
        return Math.ceil(text.length / 4);
      }
      const content =
        typeof text.content === "string"
          ? text.content
          : Array.isArray(text.content)
            ? text.content.map((p) => (typeof p === "string" ? p : p.value || "")).join("")
            : "";
      return Math.ceil(content.length / 4);
    },
  };

  // Register (stable API: registerLanguageModelChatProvider)
  try {
    disposable = vscode.lm.registerLanguageModelChatProvider("personal-openai", provider);
    context.subscriptions.push(disposable);
    debug("LM provider registered OK, models=" + buildModelList().length);
  } catch (e) {
    console.error("personal-openai: registerLanguageModelChatProvider failed:", e);
    debug("❌ LM registration FAILED: " + e.message);
    vscode.window.showErrorMessage("Personal OpenAI: LM registration failed — " + e.message);
  }

  // Notify VS Code when provider config changes so Copilot refreshes its model list
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("personalOpenAI.providers")) {
        _onDidChange.fire();
      }
    })
  );
}

// ─── Status Bar ────────────────────────────────────────────────────────────

function createStatusBar(context) {
  const bar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  bar.command = "personalOpenAI.pickModel";
  bar.tooltip = "Click to switch Personal OpenAI model";
  context.subscriptions.push(bar);

  const update = () => {
    const active = cfg().get("activeModel");
    const provider = cfg().get("activeProvider");
    if (active) {
      bar.text = `$(hubot) ${active}`;
      bar.show();
    } else if (getProviders().length > 0) {
      bar.text = `$(hubot) Pick model`;
      bar.show();
    } else {
      bar.hide();
    }
  };

  update();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("personalOpenAI")) update();
    })
  );
}

// ─── Config WebView HTML ───────────────────────────────────────────────────

function getConfigHtml(providers) {
  const providerJson = JSON.stringify(providers);
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Configure Provider</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
    padding: 24px;
    max-width: 640px;
  }
  h2 { margin-bottom: 20px; font-size: 1.2em; }
  h3 { margin-bottom: 14px; font-size: 1em; }
  label { display: block; margin-bottom: 4px; opacity: 0.8; font-size: 0.9em; }
  input, select, textarea {
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 4px;
    padding: 7px 10px;
    font-family: inherit;
    font-size: inherit;
    margin-bottom: 14px;
  }
  input:focus, select:focus, textarea:focus {
    outline: 1px solid var(--vscode-focusBorder);
    border-color: var(--vscode-focusBorder);
  }
  .row { display: flex; gap: 8px; align-items: flex-start; }
  .row input { margin-bottom: 0; }
  .field { margin-bottom: 14px; }
  .field > input, .field > select, .field > textarea { margin-bottom: 0; }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    padding: 7px 16px;
    cursor: pointer;
    font-size: inherit;
    font-family: inherit;
  }
  button:hover { opacity: 0.85; }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.danger {
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    color: var(--vscode-button-foreground);
  }
  .btn-row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .divider { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 24px 0; }
  .providers-list { margin-bottom: 20px; }
  .provider-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 6px;
    margin-bottom: 8px;
    cursor: pointer;
  }
  .provider-item:hover { border-color: var(--vscode-focusBorder); }
  .provider-item .pname { font-weight: 600; }
  .provider-item .pdetail { font-size: 0.82em; opacity: 0.65; margin-top: 2px; }
  .toast {
    position: fixed; bottom: 20px; right: 20px;
    background: var(--vscode-notificationCenterHeader-background, #333);
    color: var(--vscode-foreground);
    padding: 10px 18px;
    border-radius: 6px;
    opacity: 0;
    transition: opacity 0.3s;
    pointer-events: none;
    font-size: 0.9em;
  }
  .toast.show { opacity: 1; }
  .model-tag {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 4px;
    padding: 2px 8px;
    margin: 2px;
    font-size: 0.85em;
  }
  .model-tag .cap {
    font-size: 0.95em;
    cursor: help;
    user-select: none;
  }
  .model-tag .cap.unknown { opacity: 0.35; }
  .model-tag .cap.no { opacity: 0.85; filter: grayscale(1); }
  .model-tag button {
    background: none; border: none; color: inherit;
    padding: 0 2px; cursor: pointer; font-size: 1em; line-height: 1;
  }
  #capsProgress {
    font-size: 0.85em; opacity: 0.7; margin-top: 4px;
    display: flex; align-items: center; gap: 6px;
  }
  #capsProgress .bar {
    flex: 1; height: 4px; background: var(--vscode-input-background);
    border-radius: 2px; overflow: hidden;
  }
  #capsProgress .bar > span {
    display: block; height: 100%; background: var(--vscode-progressBar-background, #0e639c);
    width: 0; transition: width 0.2s;
  }
  #modelTags { display: flex; flex-wrap: wrap; margin-bottom: 8px; min-height: 28px; }
  #fetchStatus { font-size: 0.85em; opacity: 0.7; margin-top: 4px; }
  .toggle-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .toggle-row label { margin: 0; opacity: 1; }
  input[type=checkbox] { width: auto; margin: 0; }
  input[type=password] { letter-spacing: 2px; }
  #showKey { cursor: pointer; font-size: 0.85em; opacity: 0.7; margin-bottom: 14px; display: block; text-decoration: underline; background: none; border: none; color: inherit; padding: 0; }
</style>
</head>
<body>
<h2>⚙️ Configure Providers</h2>

<div class="providers-list" id="providerList"></div>
<button class="secondary" id="newBtn">➕ Add new provider</button>

<hr class="divider">

<div id="formSection" style="display:none">
  <h3 id="formTitle">New Provider</h3>

  <label>Display name</label>
  <input type="text" id="fName" placeholder="e.g. Ollama Local">

  <label>Base URL</label>
  <input type="text" id="fEndpoint" placeholder="e.g. http://localhost:11434/v1">

  <label>API Key</label>
  <input type="password" id="fApiKey" placeholder="Leave blank if not required or to keep existing">
  <button id="showKey">Show / hide key</button>

  <label>Models <span style="opacity:0.6;font-weight:normal">— 🔧 = tools supported · click badge to toggle</span></label>
  <div id="modelTags"></div>
  <div class="row">
    <input type="text" id="modelInput" placeholder="model-id, press Enter or comma to add">
    <button class="secondary" id="fetchBtn" style="white-space:nowrap">Fetch from API</button>
    <button class="secondary" id="detectBtn" style="white-space:nowrap" title="Re-detect tool/vision capabilities">🔍 Detect</button>
  </div>
  <div id="fetchStatus"></div>
  <div id="capsProgress" style="display:none">
    <span id="capsLabel"></span>
    <div class="bar"><span id="capsBar"></span></div>
  </div>

  <div style="margin-top:14px">
    <label>Default model</label>
    <select id="fDefaultModel"><option value="">— none —</option></select>
  </div>

  <div style="margin-top:14px">
    <label>Context window (tokens)</label>
    <input type="number" id="fContextWindow" value="128000" min="1024">
  </div>

  <div class="toggle-row" style="margin-top:8px">
    <input type="checkbox" id="fToolCalling" checked>
    <label for="fToolCalling">Tool calling (agent mode)</label>
  </div>
  <div class="toggle-row">
    <input type="checkbox" id="fImageInput">
    <label for="fImageInput">Image input (vision models)</label>
  </div>

  <div class="btn-row">
    <button id="saveBtn">💾 Save</button>
    <button class="secondary" id="cancelBtn">Cancel</button>
    <button class="danger" id="deleteBtn" style="display:none">🗑 Delete</button>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const vscode = acquireVsCodeApi();
let providers = ${providerJson};
let editingName = null;
let models = [];
let modelCaps = {}; // { modelId: { toolCalling, imageInput, source } }

// ── Render provider list ──

function renderList() {
  const el = document.getElementById("providerList");
  if (!providers.length) {
    el.innerHTML = '<div style="opacity:0.5;margin-bottom:8px">No providers yet.</div>';
    return;
  }
  el.innerHTML = providers.map(p => \`
    <div class="provider-item" data-name="\${esc(p.name)}" onclick="editProvider(this.dataset.name)">
      <div>
        <div class="pname">\${esc(p.name)}</div>
        <div class="pdetail">\${esc(p.endpoint)} · \${p.models?.length ?? 0} model(s)</div>
      </div>
      <span style="opacity:0.4">✏️</span>
    </div>\`).join("");
}

function esc(s) {
  return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Model tags ──

function capBadge(m) {
  const c = modelCaps[m];
  if (!c) {
    return \`<span class="cap unknown" data-retry="\${esc(m)}" title="Not detected yet — click to probe">❓</span>\`;
  }
  if (c.source === "timeout") {
    return \`<span class="cap unknown" data-retry="\${esc(m)}" title="Probe timed out — click to retry with 60s timeout">⏱</span>\`;
  }
  if (c.source === "error" || typeof c.toolCalling !== "boolean") {
    return \`<span class="cap unknown" data-retry="\${esc(m)}" title="Probe failed — click to retry">⚠</span>\`;
  }
  return c.toolCalling
    ? \`<span class="cap" data-cap="tool" data-model="\${esc(m)}" title="Tools supported (\${esc(c.source || "")}) — click to override">🔧</span>\`
    : \`<span class="cap no" data-cap="tool" data-model="\${esc(m)}" title="No tool support (\${esc(c.source || "")}) — click to override">🚫</span>\`;
}

function renderTags() {
  document.getElementById("modelTags").innerHTML =
    models.map((m, i) =>
      \`<span class="model-tag">\${esc(m)} \${capBadge(m)}<button onclick="removeModel(\${i})" title="Remove">✕</button></span>\`
    ).join("");
  // Wire click handlers on cap badges (toggle override)
  document.querySelectorAll("#modelTags .cap[data-cap='tool']").forEach(el => {
    el.addEventListener("click", () => {
      const m = el.getAttribute("data-model");
      const cur = modelCaps[m] || { toolCalling: true, imageInput: false };
      modelCaps[m] = { ...cur, toolCalling: !cur.toolCalling, source: "manual" };
      renderTags();
    });
  });
  // Retry handler for unknown/timeout badges — single-model probe with extended timeout
  document.querySelectorAll("#modelTags .cap.unknown[data-retry]").forEach(el => {
    el.addEventListener("click", () => {
      const m = el.getAttribute("data-retry");
      const endpoint = document.getElementById("fEndpoint").value.trim();
      const apiKey = document.getElementById("fApiKey").value.trim();
      const name = document.getElementById("fName").value.trim();
      if (!endpoint) return;
      el.textContent = "⏳";
      vscode.postMessage({
        type: "detectCapabilities",
        endpoint, apiKey, name,
        models: [m],
        timeoutMs: 60000,
        concurrency: 1,
      });
    });
  });
  const sel = document.getElementById("fDefaultModel");
  const cur = sel.value;
  sel.innerHTML = '<option value="">— none —</option>' +
    models.map(m => \`<option value="\${esc(m)}" \${m===cur?"selected":""}>\${esc(m)}</option>\`).join("");
}

function addModel(id) {
  const parts = id.split(",").map(s => s.trim()).filter(Boolean);
  for (const p of parts) if (!models.includes(p)) models.push(p);
  renderTags();
}

function removeModel(i) {
  const m = models[i];
  models.splice(i, 1);
  if (m) delete modelCaps[m];
  renderTags();
}

document.getElementById("modelInput").addEventListener("keydown", e => {
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    addModel(e.target.value);
    e.target.value = "";
  }
});
document.getElementById("modelInput").addEventListener("blur", e => {
  if (e.target.value.trim()) { addModel(e.target.value); e.target.value = ""; }
});

// ── Form open/close ──

function openForm(provider = null) {
  editingName = provider ? provider.name : null;
  models = provider ? [...(provider.models || [])] : [];
  modelCaps = provider ? { ...(provider.modelCapabilities || {}) } : {};

  document.getElementById("fName").value = provider?.name || "";
  document.getElementById("fEndpoint").value = provider?.endpoint || "";
  document.getElementById("fApiKey").value = "";
  document.getElementById("fContextWindow").value = provider?.contextWindow ?? 128000;
  document.getElementById("fToolCalling").checked = provider?.toolCalling ?? true;
  document.getElementById("fImageInput").checked = provider?.imageInput ?? false;
  document.getElementById("fetchStatus").textContent = "";
  document.getElementById("modelInput").value = "";
  document.getElementById("formTitle").textContent = provider ? \`Edit: \${provider.name}\` : "New Provider";
  document.getElementById("deleteBtn").style.display = provider ? "" : "none";
  renderTags();
  document.getElementById("formSection").style.display = "";
  document.getElementById("fName").focus();
}

function closeForm() {
  document.getElementById("formSection").style.display = "none";
  editingName = null;
}

function editProvider(name) {
  const p = providers.find(p => p.name === name);
  if (p) openForm(p);
}

document.getElementById("newBtn").addEventListener("click", () => openForm(null));
document.getElementById("cancelBtn").addEventListener("click", closeForm);

// ── Show/hide key ──
document.getElementById("showKey").addEventListener("click", () => {
  const inp = document.getElementById("fApiKey");
  inp.type = inp.type === "password" ? "text" : "password";
});

// ── Fetch models ──
document.getElementById("fetchBtn").addEventListener("click", () => {
  const endpoint = document.getElementById("fEndpoint").value.trim();
  const apiKey = document.getElementById("fApiKey").value.trim();
  const name = document.getElementById("fName").value.trim();
  if (!endpoint) { document.getElementById("fetchStatus").textContent = "⚠ Enter a base URL first."; return; }
  document.getElementById("fetchStatus").textContent = "⏳ Fetching…";
  vscode.postMessage({ type: "fetchModels", endpoint, apiKey, name });
});

// ── Re-detect capabilities for current models ──
document.getElementById("detectBtn").addEventListener("click", () => {
  const endpoint = document.getElementById("fEndpoint").value.trim();
  const apiKey = document.getElementById("fApiKey").value.trim();
  const name = document.getElementById("fName").value.trim();
  if (!endpoint || !models.length) {
    document.getElementById("fetchStatus").textContent = "⚠ Need endpoint and at least one model.";
    return;
  }
  vscode.postMessage({ type: "detectCapabilities", endpoint, apiKey, name, models });
});

// ── Save ──
document.getElementById("saveBtn").addEventListener("click", () => {
  const name = document.getElementById("fName").value.trim();
  const endpoint = document.getElementById("fEndpoint").value.trim();
  if (!name) { alert("Name is required."); return; }
  if (!endpoint) { alert("Endpoint is required."); return; }

  vscode.postMessage({
    type: "save",
    name,
    endpoint,
    apiKey: document.getElementById("fApiKey").value,
    models,
    defaultModel: document.getElementById("fDefaultModel").value,
    toolCalling: document.getElementById("fToolCalling").checked,
    imageInput: document.getElementById("fImageInput").checked,
    contextWindow: document.getElementById("fContextWindow").value,
    modelCapabilities: modelCaps,
    editingName,
  });
});

// ── Delete ──
document.getElementById("deleteBtn").addEventListener("click", () => {
  if (!editingName) return;
  if (!confirm(\`Delete provider "\${editingName}"?\`)) return;
  vscode.postMessage({ type: "delete", name: editingName });
});

// ── Toast ──
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2500);
}

// ── Messages from extension ──
window.addEventListener("message", ({ data }) => {
  if (data.type === "models") {
    models = data.models;
    // Drop caps for models that disappeared, keep the rest
    const kept = {};
    for (const m of models) if (modelCaps[m]) kept[m] = modelCaps[m];
    modelCaps = kept;
    renderTags();
    document.getElementById("fetchStatus").textContent = \`✅ \${models.length} model(s) fetched.\`;
  }
  if (data.type === "fetchError") {
    document.getElementById("fetchStatus").textContent = "❌ " + data.message;
  }
  if (data.type === "capsProgress") {
    const wrap = document.getElementById("capsProgress");
    wrap.style.display = "";
    const pct = data.total ? Math.round((data.done / data.total) * 100) : 0;
    document.getElementById("capsLabel").textContent =
      \`🔍 Detecting capabilities \${data.done}/\${data.total}\` + (data.current ? \` · \${data.current}\` : "");
    document.getElementById("capsBar").style.width = pct + "%";
  }
  if (data.type === "capsResult") {
    // Merge: don't override manual entries
    for (const [m, c] of Object.entries(data.capabilities || {})) {
      if (modelCaps[m]?.source === "manual") continue;
      modelCaps[m] = c;
    }
    renderTags();
    document.getElementById("capsLabel").textContent = \`✅ Detected \${Object.keys(data.capabilities || {}).length} model(s)\`;
    setTimeout(() => { document.getElementById("capsProgress").style.display = "none"; }, 2500);
  }
  if (data.type === "capsError") {
    document.getElementById("capsLabel").textContent = "❌ Detection failed: " + data.message;
  }
  if (data.type === "saved") {
    // Reload provider list with full updated object
    const savedProvider = data.provider;
    if (data.editingName) {
      providers = providers.map(p => p.name === data.editingName ? savedProvider : p);
    } else {
      providers.push(savedProvider);
    }
    renderList();
    closeForm();
    toast(\`✅ Provider "\${savedProvider.name}" saved.\`);
  }
  if (data.type === "deleted") {
    providers = providers.filter(p => p.name !== data.name);
    renderList();
    closeForm();
    toast(\`🗑 Provider "\${data.name}" deleted.\`);
  }
});

// Init
renderList();
</script>
</body>
</html>`;
}

// ─── Chat WebView HTML ─────────────────────────────────────────────────────

function getChatHtml() {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Personal OpenAI Chat</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }
  #toolbar {
    display: flex;
    gap: 6px;
    padding: 8px;
    background: var(--vscode-sideBar-background);
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  select, button {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    padding: 4px 8px;
    border-radius: 4px;
    font-size: inherit;
    cursor: pointer;
  }
  select { flex: 1; }
  button:hover { opacity: 0.85; }
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .msg {
    max-width: 92%;
    padding: 10px 14px;
    border-radius: 10px;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.5;
  }
  .msg.user {
    align-self: flex-end;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .msg.assistant {
    align-self: flex-start;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
  }
  .msg.error {
    align-self: flex-start;
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
  }
  #inputArea {
    display: flex;
    gap: 6px;
    padding: 8px;
    border-top: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  textarea {
    flex: 1;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 6px;
    padding: 8px;
    font-family: inherit;
    font-size: inherit;
    resize: none;
    min-height: 40px;
    max-height: 200px;
  }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  #sendBtn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 8px 16px;
    align-self: flex-end;
  }
  #stopBtn {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    padding: 8px 12px;
    align-self: flex-end;
    display: none;
  }
  .spinner::after {
    content: " ▌";
    animation: blink 0.7s step-end infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }
  #empty {
    color: var(--vscode-descriptionForeground);
    text-align: center;
    margin: auto;
    opacity: 0.6;
  }
</style>
</head>
<body>
<div id="toolbar">
  <select id="providerSelect"><option>No providers</option></select>
  <select id="modelSelect"><option>No models</option></select>
  <button id="clearBtn" title="Clear chat">🗑</button>
  <button id="refreshBtn" title="Refresh providers">↺</button>
</div>
<div id="messages"><div id="empty">Start a conversation…</div></div>
<div id="inputArea">
  <textarea id="input" rows="2" placeholder="Type a message… (Enter to send, Shift+Enter for newline)"></textarea>
  <button id="sendBtn">Send</button>
  <button id="stopBtn">Stop</button>
</div>

<script>
const vscode = acquireVsCodeApi();
let providers = [];
let history = [];
let currentId = null;

const providerSel = document.getElementById("providerSelect");
const modelSel = document.getElementById("modelSelect");
const messages = document.getElementById("messages");
const input = document.getElementById("input");
const sendBtn = document.getElementById("sendBtn");
const stopBtn = document.getElementById("stopBtn");
const empty = document.getElementById("empty");

// ── Provider / model selectors ──

providerSel.addEventListener("change", () => {
  const p = providers.find(p => p.name === providerSel.value);
  modelSel.innerHTML = (p?.models || []).map(m =>
    \`<option value="\${m}">\${m}</option>\`).join("") || "<option>No models</option>";
});

document.getElementById("refreshBtn").addEventListener("click", () => {
  vscode.postMessage({ type: "refreshProviders" });
});

document.getElementById("clearBtn").addEventListener("click", () => {
  history = [];
  messages.innerHTML = "";
  messages.appendChild(empty);
  empty.style.display = "";
});

// ── Send message ──

function sendMessage() {
  const text = input.value.trim();
  if (!text || currentId) return;
  const providerName = providerSel.value;
  const model = modelSel.value;
  if (!providerName || providerName === "No providers") {
    appendMsg("No provider selected.", "error"); return;
  }

  empty.style.display = "none";
  appendMsg(text, "user");
  history.push({ role: "user", content: text });
  input.value = "";
  input.style.height = "auto";

  currentId = Math.random().toString(36).slice(2);
  vscode.postMessage({ type: "send", id: currentId, providerName, model, history });
}

sendBtn.addEventListener("click", sendMessage);
stopBtn.addEventListener("click", () => {
  if (currentId) {
    vscode.postMessage({ type: "abort", id: currentId });
  }
});
input.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
});

// ── Message rendering ──

let currentEl = null;
let currentText = "";

function appendMsg(text, role) {
  const el = document.createElement("div");
  el.className = \`msg \${role}\`;
  el.textContent = text;
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
  return el;
}

// ── Handle messages from extension ──

window.addEventListener("message", ({ data }) => {
  if (data.type === "providers") {
    providers = data.providers || [];
    providerSel.innerHTML = providers.length
      ? providers.map(p => \`<option value="\${p.name}">\${p.name}</option>\`).join("")
      : "<option>No providers</option>";
    providerSel.dispatchEvent(new Event("change"));
    return;
  }

  if (data.id !== currentId) return;

  if (data.type === "start") {
    currentText = "";
    currentEl = appendMsg("", "assistant spinner");
    sendBtn.style.display = "none";
    stopBtn.style.display = "";
  }

  if (data.type === "chunk") {
    currentText += data.text;
    if (currentEl) currentEl.textContent = currentText;
    messages.scrollTop = messages.scrollHeight;
  }

  if (data.type === "done") {
    if (currentEl) currentEl.className = "msg assistant";
    history.push({ role: "assistant", content: currentText });
    currentEl = null; currentText = ""; currentId = null;
    sendBtn.style.display = ""; stopBtn.style.display = "none";
  }

  if (data.type === "error") {
    if (currentEl) currentEl.remove();
    appendMsg("Error: " + data.text, "error");
    currentEl = null; currentText = ""; currentId = null;
    sendBtn.style.display = ""; stopBtn.style.display = "none";
  }
});
</script>
</body>
</html>`;
}

// ─── Activate / Deactivate ─────────────────────────────────────────────────

function activate(context) {
  try {
    initDebugLog(context);
    debug("activate() called — extension starting");
    createStatusBar(context);
    registerLanguageModels(context);

    vscode.window.showInformationMessage("Personal OpenAI: extension activée ✓");

    context.subscriptions.push(
      vscode.commands.registerCommand("personalOpenAI.openChat", () =>
        cmdOpenChat(context)
      ),
      vscode.commands.registerCommand("personalOpenAI.configureProvider", () =>
        cmdConfigureProvider(context)
      ),
      vscode.commands.registerCommand("personalOpenAI.pickModel", () =>
        cmdPickModel(context)
      ),
      vscode.commands.registerCommand("personalOpenAI.testConnection", () =>
        cmdTestConnection(context)
      ),
      vscode.commands.registerCommand("personalOpenAI.clearApiKey", () =>
        cmdClearApiKey(context)
      )
    );
  } catch (e) {
    console.error("[personal-openai] Fatal activation error:", e);
    vscode.window.showErrorMessage(`Personal OpenAI: activation failed - ${e.message}`);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };