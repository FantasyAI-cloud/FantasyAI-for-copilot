// extension.js — FantasyAI for Copilot
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ─── Constants ─────────────────────────────────────────────────────────────

const FANTASYAI_ENDPOINT = "https://fantasyai.cloud/api/v1";
const FANTASYAI_VENDOR = "fantasyai";
const SECRET_KEY = "fantasyAI.apiKey";

// ─── API model catalog ─────────────────────────────────────────────────────

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
let modelCatalog = [];
let modelsLoadedAt = null;
let modelCatalogRevision = 0;
let modelCatalogRequest = null;

function resetModelCatalog() {
  modelCatalog = [];
  modelsLoadedAt = null;
  modelCatalogRevision++;
  modelCatalogRequest = null;
  modelChangeEmitter?.fire();
}

function positiveTokenLimit(...values) {
  return values.find(value => Number.isSafeInteger(value) && value > 0);
}

function parseModelCatalog(payload) {
  if (!Array.isArray(payload?.data)) {
    throw new Error("Invalid /models response: expected a data array.");
  }
  const models = new Map();
  for (const model of payload.data) {
    if (!model || typeof model.id !== "string" || !model.id.trim()) {
      throw new Error("Invalid /models response: model ID is missing.");
    }
    const capabilities = Array.isArray(model.capabilities) ? model.capabilities : [];
    if (["image", "video"].includes(model.family) ||
        capabilities.some(cap => ["image-generation", "video-generation"].includes(cap))) continue;
    if (models.has(model.id)) continue;
    models.set(model.id, {
      id: model.id,
      label: model.display_name || model.id,
      toolCalling: capabilities.includes("tools"),
      imageInput: capabilities.includes("vision"),
      maxContextTokens: positiveTokenLimit(model.max_input_tokens, model.context_window, 32768),
      maxOutputTokens: positiveTokenLimit(model.max_output_tokens, model.max_tokens, 8192),
    });
  }
  return [...models.values()];
}

// Cache successful results in memory; a failed refresh keeps the last API list.
// Shared requests avoid duplicate fetches when Copilot and commands load together.
async function loadModels(context, { force = false, silent = true } = {}) {
  const revision = modelCatalogRevision;
  const apiKey = await getApiKey(context);
  if (revision !== modelCatalogRevision) return false;
  if (!force && modelsLoadedAt !== null && Date.now() - modelsLoadedAt < MODEL_CACHE_TTL_MS) return true;

  if (!modelCatalogRequest) {
    const request = {};
    request.promise = (async () => {
      try {
        const payload = await callOpenAISimple(FANTASYAI_ENDPOINT, apiKey, "/models", {
          signal: AbortSignal.timeout(cfg().get("requestTimeoutMs") ?? 120000),
        });
        const models = parseModelCatalog(payload);
        // A response for a previous API key must never replace the current list.
        if (revision !== modelCatalogRevision) return false;
        modelCatalog = models;
        modelsLoadedAt = Date.now();
        debug(`[models] loaded ${models.length} chat model(s)`);
        modelChangeEmitter?.fire();
        return true;
      } finally {
        if (modelCatalogRequest === request) modelCatalogRequest = null;
      }
    })();
    modelCatalogRequest = request;
  }
  try {
    return await modelCatalogRequest.promise;
  } catch (e) {
    debug(`[models] failed: ${e.message}`);
    if (!silent) vscode.window.showErrorMessage(`FantasyAI: couldn't load models: ${e.message}`);
    return false;
  }
}

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
  resetModelCatalog();
}

async function deleteApiKeySecret(context) {
  await context.secrets.delete(SECRET_KEY);
  resetModelCatalog();
}

// ─── Model change signal ─────────────────────────────────────────────────────

/** @type {vscode.EventEmitter<void> | null} */
let modelChangeEmitter = null;

// ─── OpenAI API call (streaming) ───────────────────────────────────────────

/**
 * OpenAI streaming with tool-call support.
 * Yields text, reasoning, or tool_calls chunks.
 */
async function* callOpenAIWithTools(endpoint, apiKey, model, messages, signal, extraBody = {}) {
  const t0 = Date.now();
  const config = cfg();
  const modelLimit = modelCatalog.find(m => m.id === model)?.maxOutputTokens ?? 8192;
  const maxTokens = Math.min(config.get("maxTokens") ?? 8192, modelLimit);
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
  // Copilot owns all of these turns, including title/summary requests without
  // tools. Keep its requested reasoning budget consistent on both transports.
  headers["x-fantasy-agent"] = "1";
  const requestedEffort = config.get("reasoningEffort") ?? "none";
  headers["x-fantasy-reasoning-effort"] = ["none", "low", "medium", "high", "max"].includes(requestedEffort)
    ? requestedEffort : "none";

  const url = endpoint.replace(/\/$/, "") + "/chat/completions";
  debug(`→ POST model=${model} msgs=${messages.length} tools=${body.tools?.length || 0} max_tokens=${body.max_tokens} reasoning=${headers["x-fantasy-reasoning-effort"]}`);

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
        if (reasoningText) {
          yield { type: "reasoning", text: reasoningText };
        }
        if (deltaText) {
          yield { type: "text", text: deltaText };
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

function resolveCaps(modelId) {
  const c = modelCatalog.find((m) => m.id === modelId);
  return {
    toolCalling: c?.toolCalling ?? true,
    imageInput: c?.imageInput ?? false,
    source: c ? "api" : "default",
  };
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
    await loadModels(context);
    vscode.window.showInformationMessage("FantasyAI API key cleared.");
    return;
  }
  await setApiKeySecret(context, trimmed);
  // Reload the catalog for the saved key and its subscription plan.
  const ok = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "FantasyAI: loading models…" },
    () => loadModels(context, { force: true, silent: false })
  );
  if (ok) {
    vscode.window.showInformationMessage(`✅ FantasyAI ready — ${modelCatalog.length} model(s) available.`);
  } else {
    vscode.window.showWarningMessage("API key saved, but models could not be loaded. Try Refresh Models.");
  }
}

async function cmdClearApiKey(context) {
  await deleteApiKeySecret(context);
  await loadModels(context);
  vscode.window.showInformationMessage("FantasyAI API key cleared.");
}

async function cmdPickModel(context) {
  const loaded = await loadModels(context, { silent: false });
  if (!loaded && modelCatalog.length === 0) return;
  if (modelCatalog.length === 0) {
    vscode.window.showInformationMessage("FantasyAI: no chat models are currently available.");
    return;
  }
  const items = modelCatalog.map((m) => {
    const badges = [];
    if (m.toolCalling) badges.push("🔧 tools");
    if (m.imageInput) badges.push("🖼 vision");
    return {
      label: m.label,
      description: badges.length ? badges.join(" · ") : "text-only",
      detail: m.id,
      model: m.id,
    };
  });

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Select active FantasyAI model",
    matchOnDetail: true,
  });
  if (!pick) return;

  await cfg().update("activeModel", pick.model, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Active model: ${pick.label}`);
}

async function cmdRefreshModels(context) {
  const ok = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "FantasyAI: refreshing…" },
    () => loadModels(context, { force: true, silent: false })
  );
  if (ok) {
    vscode.window.showInformationMessage(`✅ ${modelCatalog.length} FantasyAI model(s) available.`);
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

function isThinkingPart(part) {
  return typeof vscode.LanguageModelThinkingPart === "function" &&
    part instanceof vscode.LanguageModelThinkingPart;
}

function thinkingText(part) {
  return Array.isArray(part.value) ? part.value.join("") : part.value || "";
}

// VS Code delivers image attachments as LanguageModelDataPart: `.data` is a
// Uint8Array and `.mimeType` a string like "image/png". Neither `.value`,
// `.name` nor `.callId` is set, so such a part matches none of the text/tool
// branches and would be dropped. Convert it to an OpenAI `image_url` content
// part (base64 data URL). Returns null for non-image / unparseable parts.
function toImagePart(part) {
  if (!part || part.data == null) return null;
  const mime = typeof part.mimeType === "string" ? part.mimeType : "image/png";
  if (!mime.startsWith("image/")) return null;
  let buf;
  try {
    buf = Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data);
  } catch {
    return null;
  }
  if (!buf || buf.length === 0) return null;
  return { type: "image_url", image_url: { url: `data:${mime};base64,${buf.toString("base64")}` } };
}

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
    // Advertised output cap honours the user's global `maxTokens` setting but is
    // never larger than the limit returned by /models. Context windows and
    // capabilities also come from the API.
    const userMaxOutput = cfg().get("maxTokens") ?? 8192;
    return modelCatalog.map((m) => {
      const badge = m.toolCalling ? " 🔧" : "";
      return {
        id: m.id,
        name: `FantasyAI / ${m.label}${badge}`,
        vendor: FANTASYAI_VENDOR,
        family: "fantasyai",
        version: "1.0",
        maxInputTokens: m.maxContextTokens,
        maxOutputTokens: Math.min(userMaxOutput, m.maxOutputTokens),
        capabilities: {
          toolCalling: m.toolCalling,
          imageInput: m.imageInput,
        },
      };
    });
  }

  const provider = {
    onDidChangeLanguageModelChatInformation: modelChangeEmitter.event,

    async provideLanguageModelChatInformation(_options, _token) {
      await loadModels(context);
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

      const toolSystemPrompt = enableTools && options.tools?.length
        ? `\n\nUse only the tools defined in this request, with their exact names and required parameters.
When asked to create or modify project files, use the workspace tools to perform the changes.
Read tool results before deciding the next action. If a tool fails, correct the cause rather than repeating an identical call.
Only claim a file was created or changed after the relevant tool succeeds. Summarize completed work when the task is finished.`
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
          // Collect text AND image parts. VS Code delivers image attachments as
          // LanguageModelDataPart (.data: Uint8Array + .mimeType) — NOT a string
          // .value — so a plain `.value` map silently drops them. Forward images
          // as OpenAI image_url (data URL) content parts.
          const textPieces = [];
          const imgPieces = [];
          for (const p of msg.content) {
            if (!p) continue;
            if (isThinkingPart(p)) continue;
            if (typeof p.value === "string") textPieces.push(p.value);
            else { const ip = toImagePart(p); if (ip) imgPieces.push(ip); }
          }
          const role = msg.role === 1 ? "user" : "assistant";
          if (imgPieces.length > 0) {
            const arr = [];
            if (textPieces.length > 0) arr.push({ type: "text", text: textPieces.join("\n") });
            for (const ip of imgPieces) arr.push(ip);
            openaiMessages.push({ role, content: arr });
          } else {
            openaiMessages.push({ role, content: textPieces.join("\n") || "" });
          }
          continue;
        }

        const textParts = [];
        const imageParts = [];
        const toolCalls = [];
        const toolResults = [];
        let historyReasoning = "";

        for (const part of msg.content) {
          if (!part) continue;

          if (isThinkingPart(part)) {
            historyReasoning += thinkingText(part);
          } else if (typeof part.name === "string" && part.input !== undefined) {
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
          } else {
            // Image attachment (LanguageModelDataPart) → OpenAI image_url part.
            const ip = toImagePart(part);
            if (ip) {
              imageParts.push(ip);
              debug(`[lm]   ← image part mime=${part.mimeType || "image/png"}`);
            }
          }
        }

        const hasText = textParts.length > 0;
        const hasImages = imageParts.length > 0;
        const hasToolCalls = toolCalls.length > 0;

        if (hasToolCalls) {
          let rc = historyReasoning;
          if (!rc) {
            for (const tc of toolCalls) {
              const c = reasoningCache.get("tool:" + tc.id) ?? reasoningCache.get(tc.id);
              if (c) { rc = c.text; break; }
            }
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

        if (hasText || hasImages) {
          const role = msg.role === 1 ? "user" : "assistant";
          if (hasImages) {
            // Mixed text+image turn → OpenAI content-parts array. The gateway's
            // extractProviderMessages lifts image_url parts into .images so the
            // describe-then-forward vision path can see them.
            const arr = [];
            if (hasText) arr.push({ type: "text", text: textParts.join("\n") });
            for (const ip of imageParts) arr.push(ip);
            openaiMessages.push({ role, content: arr });
          } else {
            const entry = { role, content: textParts.join("\n") };
            if (role === "assistant" && historyReasoning) entry.reasoning_content = historyReasoning;
            openaiMessages.push(entry);
          }
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
      // Use the native thinking part, as in Vizards/deepseek-v4-for-copilot.
      // This API is still proposed: guard it for hosts that do not expose it.
      // Reasoning remains cached for tool continuations even when hidden.
      const showReasoning = cfg().get("showReasoning", true);
      const nativeThinking = typeof vscode.LanguageModelThinkingPart === "function";
      if (showReasoning && !nativeThinking) {
        debug("[lm] Native thinking API unavailable; reasoning display disabled. Update VS Code to enable it.");
      }

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
            if (showReasoning && nativeThinking) {
              progress.report(new vscode.LanguageModelThinkingPart(chunk.text));
            }
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
    bar.text = active ? `$(hubot) ${active}` : `$(hubot) Pick model`;
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
            e.affectsConfiguration("fantasyAI.maxTokens")) {
          modelChangeEmitter?.fire();
        }
      })
    );

    const key = await getApiKey(context);
    if (!key) {
      vscode.window.showInformationMessage(
        "FantasyAI: set your API key to use the models.",
        "Set API Key"
      ).then((choice) => {
        if (choice === "Set API Key") {
          vscode.commands.executeCommand("fantasyAI.setApiKey");
        }
      });
    }
    // Load the plan-aware API catalog, including the public list without a key.
    await loadModels(context);
  } catch (e) {
    console.error("[fantasyai] Fatal activation error:", e);
    vscode.window.showErrorMessage(`FantasyAI: activation failed - ${e.message}`);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
