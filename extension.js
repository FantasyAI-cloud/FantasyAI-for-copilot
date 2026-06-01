// extension.js — FantasyAI for Copilot
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ─── Constants ─────────────────────────────────────────────────────────────

const FANTASYAI_ENDPOINT = "https://fantasyai.cloud/api/v1";
const FANTASYAI_VENDOR = "fantasyai";
const SECRET_KEY = "fantasyAI.apiKey";
const CACHE_KEY = "fantasyAI.modelCache";

// ─── Debug logger ──────────────────────────────────────────────────────────

let debugLogPath = null;
function debug(...args) {
  const ts = new Date().toISOString().slice(11, 23);
  const msg = args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ");
  console.log(`[FAI ${ts}] ${msg}`);
  if (debugLogPath) {
    try { fs.appendFileSync(debugLogPath, `[${ts}] ${msg}\n`); } catch {}
  }
}

function initDebugLog(_context) {
  if (debugLogPath) return;
  const candidates = [
    path.join(os.tmpdir(), "fantasyai-debug.log"),
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
  return vscode.workspace.getConfiguration("fantasyAI");
}

async function getApiKey(context) {
  return context.secrets.get(SECRET_KEY);
}

async function setApiKeySecret(context, key) {
  await context.secrets.store(SECRET_KEY, key);
}

async function deleteApiKeySecret(context) {
  await context.secrets.delete(SECRET_KEY);
}

// ─── Model cache ─────────────────────────────────────────────────────────────

/** @type {{ models: string[], capabilities: Record<string, {toolCalling?: boolean, imageInput?: boolean, source?: string}>, fetchedAt: number }} */
let modelCache = { models: [], capabilities: {}, fetchedAt: 0 };

/** @type {vscode.EventEmitter<void> | null} */
let modelChangeEmitter = null;

function loadCacheFromStorage(context) {
  const cached = context.globalState.get(CACHE_KEY);
  if (cached && Array.isArray(cached.models)) {
    modelCache = {
      models: cached.models,
      capabilities: cached.capabilities || {},
      fetchedAt: cached.fetchedAt || 0,
    };
    debug(`[cache] loaded ${modelCache.models.length} model(s) from storage`);
  }
}

async function saveCacheToStorage(context) {
  await context.globalState.update(CACHE_KEY, modelCache);
}

// ─── OpenAI API call (streaming) ───────────────────────────────────────────

/**
 * OpenAI streaming with tool-call support.
 * Yields { type: "text", text: string } | { type: "tool_calls", calls: array }
 */
async function* callOpenAIWithTools(endpoint, apiKey, model, messages, signal, extraBody = {}) {
  const t0 = Date.now();
  const config = cfg();
  const maxTokens = Math.min(config.get("maxTokens") ?? 8192, 32768);
  const body = {
    model,
    messages,
    stream: true,
    temperature: config.get("temperature") ?? 0.2,
    max_tokens: maxTokens,
    ...extraBody,
  };

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

  const toolCallsAcc = {};
  let chunkCount = 0;
  let lastChunkTime = Date.now();
  const STREAM_TIMEOUT_MS = 120_000;

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

        const deltaText = choice.delta?.content;
        const reasoningText = choice.delta?.reasoning_content;
        if (deltaText) {
          yield { type: "text", text: deltaText };
        }
        if (reasoningText) {
          yield { type: "reasoning", text: reasoningText };
        }

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

        if (choice.finish_reason === "tool_calls") {
          const calls = Object.values(toolCallsAcc).filter((c) => c.id && c.name);
          if (calls.length > 0) {
            const callNames = calls.map(c => `${c.name}(${(c.arguments || "").slice(0, 80)})`).join(",");
            debug(`🔧 tool_calls: ${callNames} (${chunkCount} chunks, ${Date.now() - t0}ms total)`);
            yield { type: "tool_calls", calls };
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

  const pending = Object.values(toolCallsAcc).filter((c) => c.id && c.name);
  if (pending.length > 0) {
    yield { type: "tool_calls", calls: pending };
  }
}

async function callOpenAISimple(endpoint, apiKey, p, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const url = endpoint.replace(/\/$/, "") + p;
  const res = await fetch(url, { headers, ...options });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Capability resolution ─────────────────────────────────────────────────
//
// Capabilities are owned by the FantasyAI gateway: `/v1/models` always returns
// a `capabilities` array for every model (see fantasy-ai/app/api/v1/models).
// The extension never probes — every probe at scale would hammer the upstream
// providers, and the gateway already learns from real runtime failures via its
// own `tool-support-cache`.

function parseGatewayCaps(data) {
  const out = {};
  for (const m of (data?.data || data?.models || [])) {
    const id = m?.id;
    if (!id) continue;
    const caps = Array.isArray(m.capabilities) ? m.capabilities : [];
    out[id] = {
      toolCalling: caps.includes("tools") || caps.includes("function_calling"),
      imageInput: caps.includes("vision") || caps.includes("image"),
      source: "gateway",
    };
  }
  return out;
}

function resolveCaps(modelId) {
  const c = modelCache.capabilities[modelId];
  return {
    toolCalling: c?.toolCalling ?? true,
    imageInput: c?.imageInput ?? false,
    source: c?.source ?? "default",
  };
}

// ─── Model refresh ─────────────────────────────────────────────────────────

async function fetchModelsAndCaps(context, { silent = true } = {}) {
  const apiKey = await getApiKey(context);
  if (!apiKey) {
    debug("[refresh] no API key — skipping");
    if (!silent) vscode.window.showWarningMessage("FantasyAI: set your API key first.");
    return null;
  }
  try {
    const data = await callOpenAISimple(FANTASYAI_ENDPOINT, apiKey, "/models");
    const models = (data.data || data.models || [])
      .map((m) => m.id || m)
      .filter(Boolean);
    if (!models.length) {
      debug("[refresh] /models returned no entries");
      return null;
    }
    const caps = parseGatewayCaps(data);
    modelCache = { models, capabilities: caps, fetchedAt: Date.now() };
    await saveCacheToStorage(context);
    modelChangeEmitter?.fire();
    debug(`[refresh] cached ${models.length} model(s) (caps from gateway)`);
    return modelCache;
  } catch (e) {
    debug(`[refresh] failed: ${e.message}`);
    if (!silent) vscode.window.showErrorMessage(`FantasyAI refresh failed: ${e.message}`);
    return null;
  }
}

// ─── Commands ──────────────────────────────────────────────────────────────

async function cmdSetApiKey(context) {
  const current = await getApiKey(context);
  const key = await vscode.window.showInputBox({
    prompt: "Enter your FantasyAI API key",
    placeHolder: "fa_…",
    password: true,
    value: current || "",
    ignoreFocusOut: true,
  });
  if (key === undefined) return;
  const trimmed = key.trim();
  if (!trimmed) {
    await deleteApiKeySecret(context);
    modelCache = { models: [], capabilities: {}, fetchedAt: 0 };
    await saveCacheToStorage(context);
    modelChangeEmitter?.fire();
    vscode.window.showInformationMessage("FantasyAI API key cleared.");
    return;
  }
  await setApiKeySecret(context, trimmed);
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "FantasyAI: loading models…" },
    () => fetchModelsAndCaps(context, { silent: false })
  );
  if (modelCache.models.length) {
    vscode.window.showInformationMessage(`✅ FantasyAI ready — ${modelCache.models.length} model(s) loaded.`);
  } else {
    vscode.window.showWarningMessage("API key saved, but no models were returned. Try Test Connection.");
  }
}

async function cmdClearApiKey(context) {
  await deleteApiKeySecret(context);
  modelCache = { models: [], capabilities: {}, fetchedAt: 0 };
  await saveCacheToStorage(context);
  modelChangeEmitter?.fire();
  vscode.window.showInformationMessage("FantasyAI API key cleared.");
}

async function cmdPickModel(context) {
  if (!modelCache.models.length) {
    const apiKey = await getApiKey(context);
    if (!apiKey) {
      const choice = await vscode.window.showWarningMessage(
        "No FantasyAI API key set.",
        "Set API Key"
      );
      if (choice === "Set API Key") vscode.commands.executeCommand("fantasyAI.setApiKey");
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "FantasyAI: loading models…" },
      () => fetchModelsAndCaps(context, { silent: false })
    );
  }
  if (!modelCache.models.length) {
    vscode.window.showWarningMessage("No FantasyAI models available.");
    return;
  }

  const items = modelCache.models.map((m) => {
    const caps = resolveCaps(m);
    const badges = [];
    if (caps.toolCalling) badges.push("🔧 tools");
    if (caps.imageInput) badges.push("🖼 vision");
    return {
      label: m,
      description: badges.length ? badges.join(" · ") : "text-only",
      model: m,
    };
  });

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Select active FantasyAI model",
  });
  if (!pick) return;

  await cfg().update("activeModel", pick.model, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Active model: ${pick.label}`);
}

async function cmdRefreshModels(context) {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "FantasyAI: refreshing models…" },
    () => fetchModelsAndCaps(context, { silent: false })
  );
  if (modelCache.models.length) {
    vscode.window.showInformationMessage(`✅ ${modelCache.models.length} FantasyAI model(s) loaded.`);
  }
}

async function cmdTestConnection(context) {
  const apiKey = await getApiKey(context);
  if (!apiKey) {
    vscode.window.showWarningMessage("Set your FantasyAI API key first.");
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Testing FantasyAI…" },
    async () => {
      try {
        await callOpenAISimple(FANTASYAI_ENDPOINT, apiKey, "/models");
        vscode.window.showInformationMessage("✅ FantasyAI is reachable.");
      } catch (e) {
        vscode.window.showErrorMessage(`❌ FantasyAI failed: ${e.message}`);
      }
    }
  );
}

// ─── Language Model Provider (Copilot integration) ─────────────────────────

function registerLanguageModels(context) {
  modelChangeEmitter = new vscode.EventEmitter();
  context.subscriptions.push(modelChangeEmitter);

  // DeepSeek requires reasoning_content in history for tool_calls msgs
  const reasoningCache = new Map();
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

  function buildModelList() {
    const contextWindow = cfg().get("contextWindow") ?? 128000;
    const maxOutputTokens = cfg().get("maxTokens") ?? 8192;
    return modelCache.models.map((modelId) => {
      const caps = resolveCaps(modelId);
      const badge = caps.toolCalling ? " 🔧" : "";
      return {
        id: modelId,
        name: `FantasyAI / ${modelId}${badge}`,
        vendor: FANTASYAI_VENDOR,
        family: "fantasyai",
        version: "1.0",
        maxInputTokens: contextWindow,
        maxOutputTokens,
        capabilities: {
          toolCalling: caps.toolCalling,
          imageInput: caps.imageInput,
        },
      };
    });
  }

  const provider = {
    onDidChangeLanguageModelChatInformation: modelChangeEmitter.event,

    async provideLanguageModelChatInformation(_options, _token) {
      return buildModelList();
    },

    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
      const tReqStart = Date.now();
      const modelId = model.id;
      const resolved = resolveCaps(modelId);
      const enableTools = resolved.toolCalling !== false;

      debug(`[lm] REQ model=${modelId} msgs=${messages.length} tools=${enableTools ? options.tools?.length || 0 : "off"}`);

      const apiKey = await getApiKey(context);
      if (!apiKey) {
        throw new Error("FantasyAI API key not set. Run \"FantasyAI: Set API Key\".");
      }

      const systemPrompt =
        cfg().get("systemPrompt") || "You are a helpful coding assistant inside VS Code.";

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

        const textParts = [];
        const toolCalls = [];
        const toolResults = [];

        for (const part of msg.content) {
          if (!part) continue;

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
            textParts.push(part.value);
          }
        }

        const hasText = textParts.length > 0;
        const hasToolCalls = toolCalls.length > 0;

        if (hasToolCalls) {
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

        if (hasText) {
          openaiMessages.push({
            role: msg.role === 1 ? "user" : "assistant",
            content: textParts.join("\n"),
          });
        }

        for (const tr of toolResults) {
          openaiMessages.push({
            role: "tool",
            tool_call_id: tr.callId,
            content: tr.content,
          });
          debug(`[lm]   → tool msg id=${tr.callId} content_len=${tr.content.length}`);
        }
      }

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

      // Tool call loop detection over recent calls only
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

      const LOOP_WINDOW = 6;
      const LOOP_THRESHOLD = 4;
      const recent = toolCallHistory.slice(-LOOP_WINDOW);

      const isEmptyOrInvalid = (inputStr) => {
        try {
          const o = JSON.parse(inputStr);
          return !o || typeof o !== "object" || Object.keys(o).length === 0;
        } catch {
          return true;
        }
      };

      const recentEmpty = recent.filter((tc) => isEmptyOrInvalid(tc.input)).length;
      const recentFreq = {};
      for (const tc of recent) {
        const sig = tc.name + "::" + tc.input;
        recentFreq[sig] = (recentFreq[sig] || 0) + 1;
      }
      const recentMaxRepeat = Math.max(0, ...Object.values(recentFreq));

      const loopDetected =
        recent.length >= LOOP_THRESHOLD &&
        recentEmpty >= LOOP_THRESHOLD &&
        recentMaxRepeat >= LOOP_THRESHOLD;

      if (loopDetected && enableTools && extraBody.tools?.length) {
        debug(`[lm] ⚠ TOOL LOOP DETECTED — window=${recent.length} empty=${recentEmpty} maxRepeat=${recentMaxRepeat} → forcing text response`);
        openaiMessages.push({
          role: "user",
          content: "SYSTEM OVERRIDE: You have repeatedly called tools with invalid or empty arguments. STOP calling tools immediately. Provide your final answer as plain text without any tool calls. Do NOT call any function."
        });
        delete extraBody.tools;
        delete extraBody.tool_choice;
      } else if (recent.length > 0) {
        debug(`[lm] loop-check: window=${recent.length} empty=${recentEmpty} maxRepeat=${recentMaxRepeat} → ok`);
      }

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
          FANTASYAI_ENDPOINT,
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

      // No tool-rejection retry here: the FantasyAI gateway already handles
      // it server-side (lib/tool-support-cache + findSimilarModels fallback)
      // and refreshing /v1/models will reflect the updated capabilities.
      await runStream(extraBody);

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

  try {
    const disposable = vscode.lm.registerLanguageModelChatProvider(FANTASYAI_VENDOR, provider);
    context.subscriptions.push(disposable);
    debug("LM provider registered OK, models=" + buildModelList().length);
  } catch (e) {
    console.error("fantasyai: registerLanguageModelChatProvider failed:", e);
    debug("❌ LM registration FAILED: " + e.message);
    vscode.window.showErrorMessage("FantasyAI: LM registration failed — " + e.message);
  }
}

// ─── Status Bar ────────────────────────────────────────────────────────────

function createStatusBar(context) {
  const bar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  bar.command = "fantasyAI.pickModel";
  bar.tooltip = "Click to switch FantasyAI model";
  context.subscriptions.push(bar);

  const update = () => {
    const active = cfg().get("activeModel");
    if (active) {
      bar.text = `$(hubot) ${active}`;
    } else if (modelCache.models.length > 0) {
      bar.text = `$(hubot) Pick model`;
    } else {
      bar.text = `$(hubot) FantasyAI`;
    }
    bar.show();
  };

  update();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("fantasyAI")) update();
    })
  );
  if (modelChangeEmitter) {
    context.subscriptions.push(modelChangeEmitter.event(update));
  }
}


// ─── Activate / Deactivate ─────────────────────────────────────────────────

async function activate(context) {
  try {
    initDebugLog(context);
    debug("activate() called — FantasyAI extension starting");

    loadCacheFromStorage(context);
    registerLanguageModels(context);
    createStatusBar(context);

    context.subscriptions.push(
      vscode.commands.registerCommand("fantasyAI.setApiKey", () => cmdSetApiKey(context)),
      vscode.commands.registerCommand("fantasyAI.clearApiKey", () => cmdClearApiKey(context)),
      vscode.commands.registerCommand("fantasyAI.pickModel", () => cmdPickModel(context)),
      vscode.commands.registerCommand("fantasyAI.refreshModels", () => cmdRefreshModels(context)),
      vscode.commands.registerCommand("fantasyAI.testConnection", () => cmdTestConnection(context))
    );

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("fantasyAI.activeModel") ||
            e.affectsConfiguration("fantasyAI.contextWindow") ||
            e.affectsConfiguration("fantasyAI.maxTokens")) {
          modelChangeEmitter?.fire();
        }
      })
    );

    // Refresh models once at startup (silent — no popup if key is missing)
    fetchModelsAndCaps(context).then(() => {
      if (!modelCache.models.length) {
        getApiKey(context).then((key) => {
          if (!key) {
            vscode.window.showInformationMessage(
              "FantasyAI: set your API key to load models.",
              "Set API Key"
            ).then((choice) => {
              if (choice === "Set API Key") {
                vscode.commands.executeCommand("fantasyAI.setApiKey");
              }
            });
          }
        });
      }
    });
  } catch (e) {
    console.error("[fantasyai] Fatal activation error:", e);
    vscode.window.showErrorMessage(`FantasyAI: activation failed - ${e.message}`);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
