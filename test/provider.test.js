const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class TextPart { constructor(value) { this.value = value; } }
class ThinkingPart { constructor(value) { this.value = value; } }
class ToolCallPart {
  constructor(callId, name, input) { Object.assign(this, { callId, name, input }); }
}

function harness({ showReasoning = true, nativeThinking = true, apiKey = "test-key", settings = {} } = {}) {
  let provider;
  let now = Date.now();
  let modelChanges = 0;
  const requests = [];
  const requestHeaders = [];
  const queuedDeltas = [];
  const modelRequests = [];
  const queuedModels = [];
  const notifications = [];
  const picks = [];
  const config = { showReasoning, ...settings };
  const vscode = {
    LanguageModelTextPart: TextPart,
    LanguageModelThinkingPart: nativeThinking ? ThinkingPart : undefined,
    LanguageModelToolCallPart: ToolCallPart,
    EventEmitter: class { event() {} fire() { modelChanges++; } },
    workspace: { getConfiguration: () => ({
      get: (key, fallback) => config[key] ?? fallback,
      update: async (key, value) => { config[key] = value; },
    }) },
    ConfigurationTarget: { Global: 1 },
    ProgressLocation: { Notification: 1 },
    window: {
      withProgress: async (_options, task) => task(),
      showErrorMessage: message => { notifications.push(message); },
      showWarningMessage: message => { notifications.push(message); },
      showInformationMessage: async message => { notifications.push(message); },
      showInputBox: async () => apiKey,
      showQuickPick: async items => { picks.push(items); return items[0]; },
    },
    lm: { registerLanguageModelChatProvider: (_vendor, value) => { provider = value; return {}; } },
  };
  const context = { subscriptions: [], secrets: {
    get: async () => apiKey,
    store: async (_key, value) => { apiKey = value; },
    delete: async () => { apiKey = undefined; },
  } };
  const sandbox = {
    require: (name) => name === "vscode" ? vscode : require(name),
    module: { exports: {} }, context, Buffer, TextDecoder, AbortController, AbortSignal,
    Date: class extends Date { static now() { return now; } },
    console: { log() {}, error() {} },
    fetch: async (url, options) => {
      if (url.endsWith("/models")) {
        modelRequests.push({ url, ...options });
        const result = await queuedModels.shift();
        if (result instanceof Error) throw result;
        return result instanceof Response ? result : Response.json(result ?? { data: [] });
      }
      requests.push(JSON.parse(options.body));
      requestHeaders.push(options.headers);
      const frames = queuedDeltas.shift() || [{ content: "Done" }];
      const sse = frames.map(({ finish_reason = null, ...delta }) =>
        `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`
      ).join("") + "data: [DONE]\n\n";
      const bytes = new TextEncoder().encode(sse);
      return new Response(new ReadableStream({ start(controller) {
        // Deliberately split SSE JSON lines and UTF-8 sequences across reads.
        for (let i = 0; i < bytes.length; i += 17) controller.enqueue(bytes.slice(i, i + 17));
        controller.close();
      } }), { headers: { "Content-Type": "text/event-stream" } });
    },
  };
  const source = fs.readFileSync(path.join(__dirname, "../extension.js"), "utf8");
  vm.runInNewContext(source + "\nregisterLanguageModels(context);", sandbox);
  return {
    provider, requests, requestHeaders, queuedDeltas, modelRequests, queuedModels, notifications, picks, config,
    get modelChanges() { return modelChanges; },
    advanceTime: ms => { now += ms; },
    refresh: () => sandbox.cmdRefreshModels(context),
    pick: () => sandbox.cmdPickModel(context),
    setKey: key => sandbox.setApiKeySecret(context, key),
    clearKey: () => sandbox.cmdClearApiKey(context),
    saveKey: () => sandbox.cmdSetApiKey(context),
    async respond(messages = [], modelId = "deepseek-v4", options = {}) {
      const parts = [];
      await provider.provideLanguageModelChatResponse(
        { id: modelId }, messages, options, { report: part => parts.push(part) },
        { onCancellationRequested() {} }
      );
      return parts;
    },
  };
}

test("models come from the API with routable IDs, names, capabilities and token budgets", async () => {
  const h = harness();
  h.queuedModels.push({ data: [
    { id: "provider/new-model:latest", display_name: "New model", capabilities: ["tools", "vision"], max_input_tokens: 131072, max_output_tokens: 4096 },
    { id: "text-only", capabilities: [], context_window: 65536, max_tokens: 16384 },
    { id: "provider/new-model:latest", display_name: "Duplicate" },
    { id: "image-model", family: "image", capabilities: ["image-generation"] },
    { id: "video-model", family: "video" },
    { id: "media-without-family", capabilities: ["image-generation"] },
  ] });
  const models = await h.provider.provideLanguageModelChatInformation();
  assert.deepEqual(Array.from(models, m => m.id), ["provider/new-model:latest", "text-only"]);
  assert.equal(models[0].name, "FantasyAI / New model 🔧");
  assert.equal(models[0].maxInputTokens, 131072);
  assert.equal(models[0].maxOutputTokens, 4096);
  assert.equal(models[0].capabilities.imageInput, true);
  assert.equal(models[0].capabilities.toolCalling, true);
  assert.equal(models[1].name, "FantasyAI / text-only");
  assert.equal(models[1].maxInputTokens, 65536);
  assert.equal(models[1].maxOutputTokens, 8192);
  assert.equal(models[1].capabilities.imageInput, false);
  assert.equal(models[1].capabilities.toolCalling, false);
  assert.equal(h.modelRequests[0].url, "http://localhost:3000/api/v1/models");
  assert.equal(h.modelRequests[0].headers.Authorization, "Bearer test-key");
  assert.ok(h.modelRequests[0].signal instanceof AbortSignal);
  const options = { tools: [{ name: "inspect", inputSchema: { type: "object" } }] };
  await h.respond([{ role: 1, content: "Hello" }], models[0].id, options);
  assert.equal(h.requests[0].model, "provider/new-model:latest");
  assert.equal(h.requests[0].max_tokens, 4096);
  assert.equal(h.requests[0].tools[0].function.name, "inspect");
  await h.respond([], models[1].id, options);
  assert.equal(h.requests[1].tools, undefined);
});

test("cached models expire after five minutes; refresh forces a new list and picker uses it", async () => {
  const h = harness();
  h.queuedModels.push({ data: [{ id: "first" }] });
  await h.provider.provideLanguageModelChatInformation();
  await h.provider.provideLanguageModelChatInformation();
  assert.equal(h.modelRequests.length, 1);
  h.advanceTime(5 * 60 * 1000);
  h.queuedModels.push({ data: [{ id: "second" }] });
  assert.equal((await h.provider.provideLanguageModelChatInformation())[0].id, "second");
  h.queuedModels.push({ data: [{ id: "third", display_name: "Third" }] });
  await h.refresh();
  assert.equal(h.modelRequests.length, 3);
  assert.equal(h.modelChanges, 3);
  assert.ok(h.notifications.some(message => message.includes("1 FantasyAI model")));
  await h.pick();
  assert.equal(h.picks[0][0].model, "third");
  assert.equal(h.config.activeModel, "third");
});

test("HTTP failures and malformed responses preserve the last successful API list", async () => {
  const h = harness();
  h.queuedModels.push({ data: [{ id: "last-good" }] });
  await h.provider.provideLanguageModelChatInformation();
  for (const response of [new Response("Unavailable", { status: 503 }), { error: "bad format" }, { data: [null] }]) {
    h.queuedModels.push(response);
    await h.refresh();
    assert.equal((await h.provider.provideLanguageModelChatInformation())[0].id, "last-good");
  }
  assert.equal(h.modelChanges, 1);
  assert.equal(h.notifications.length, 3);
});

test("first-load network failure returns no hardcoded models and can be retried", async () => {
  const h = harness();
  h.queuedModels.push(new Error("Network unavailable"));
  assert.equal((await h.provider.provideLanguageModelChatInformation()).length, 0);
  h.queuedModels.push({ data: [{ id: "recovered" }] });
  assert.equal((await h.provider.provideLanguageModelChatInformation())[0].id, "recovered");
});

test("an empty API list is cached and clears previously advertised models", async () => {
  const h = harness();
  h.queuedModels.push({ data: [{ id: "removed" }] });
  await h.provider.provideLanguageModelChatInformation();
  h.queuedModels.push({ data: [] });
  await h.refresh();
  assert.equal((await h.provider.provideLanguageModelChatInformation()).length, 0);
  await h.pick();
  assert.equal(h.picks.length, 0);
  assert.equal(h.modelRequests.length, 2);
});

test("concurrent discovery shares one request", async () => {
  const h = harness();
  let resolve;
  h.queuedModels.push(new Promise(done => { resolve = done; }));
  const first = h.provider.provideLanguageModelChatInformation();
  const second = h.provider.provideLanguageModelChatInformation();
  await new Promise(done => setImmediate(done));
  assert.equal(h.modelRequests.length, 1);
  resolve({ data: [{ id: "shared" }] });
  const results = await Promise.all([first, second]);
  assert.ok(results.every(models => models[0].id === "shared"));
});

test("changing or clearing the key invalidates cached and in-flight catalogs", async () => {
  const h = harness();
  let resolveOld;
  h.queuedModels.push(new Promise(done => { resolveOld = done; }));
  const oldLoad = h.provider.provideLanguageModelChatInformation();
  await new Promise(done => setImmediate(done));
  await h.setKey("new-key");
  h.queuedModels.push({ data: [{ id: "new-account" }] });
  await h.saveKey();
  assert.equal(h.modelRequests.at(-1).headers.Authorization, "Bearer new-key");
  resolveOld({ data: [{ id: "old-account" }] });
  await oldLoad;
  assert.equal((await h.provider.provideLanguageModelChatInformation())[0].id, "new-account");
  h.queuedModels.push({ data: [{ id: "public" }] });
  await h.clearKey();
  assert.equal(h.modelRequests.at(-1).headers.Authorization, undefined);
  assert.equal((await h.provider.provideLanguageModelChatInformation())[0].id, "public");
});

test("the public catalog is fetched without a key and invalid token limits get safe defaults", async () => {
  const h = harness({ apiKey: null });
  h.queuedModels.push({ data: [{ id: "public", max_input_tokens: -1, max_output_tokens: 0, max_tokens: "bad" }] });
  const models = await h.provider.provideLanguageModelChatInformation();
  assert.equal(h.modelRequests[0].headers.Authorization, undefined);
  assert.equal(models[0].maxInputTokens, 32768);
  assert.equal(models[0].maxOutputTokens, 8192);
});

test("streaming honors API output limits above the old fixed 32768 cap", async () => {
  const h = harness({ settings: { maxTokens: 65536 } });
  h.queuedModels.push({ data: [{ id: "large-output", max_output_tokens: 131072 }] });
  const models = await h.provider.provideLanguageModelChatInformation();
  await h.respond([], "large-output");
  assert.equal(models[0].maxOutputTokens, 65536);
  assert.equal(h.requests[0].max_tokens, 65536);
});

test("reasoning streams as native parts without Markdown in the answer", async () => {
  const h = harness();
  h.queuedDeltas.push([
    { reasoning_content: "Réflexion\n" }, { reasoning_content: "Suite" },
    { content: "Answer" }, { content: "!" },
  ]);
  const parts = await h.respond();
  assert.deepEqual(parts.map(p => [p.constructor.name, p.value]), [
    ["ThinkingPart", "Réflexion\n"], ["ThinkingPart", "Suite"],
    ["TextPart", "Answer"], ["TextPart", "!"],
  ]);
});

test("marks Copilot tool turns, continuations and utility requests as agent requests", async () => {
  const h = harness();
  await h.respond([{ role: 1, content: "Create main.py" }], "gemma", {
    tools: [{ name: "create_file", inputSchema: { type: "object" } }],
  });
  assert.equal(h.requestHeaders[0]["x-fantasy-agent"], "1");
  assert.ok(!h.requests[0].messages[0].content.includes("manage_todo_list"));
  await h.respond([
    { role: 2, content: [new ToolCallPart("call-1", "create_file", { path: "main.py" })] },
    { role: 1, content: [{ callId: "call-1", content: "File created" }] },
  ], "gemma");
  assert.equal(h.requestHeaders[1]["x-fantasy-agent"], "1");
  await h.respond([{ role: 1, content: "Generate a short conversation title" }], "gemma");
  assert.equal(h.requestHeaders[2]["x-fantasy-agent"], "1");
  for (const headers of h.requestHeaders) assert.equal(headers["x-fantasy-reasoning-effort"], "none");
});

for (const effort of ["none", "low", "medium", "high", "max", "invalid"]) {
  test(`sends the configured generation reasoning budget independently of its display (${effort})`, async () => {
    const h = harness({ showReasoning: false, settings: { reasoningEffort: effort } });
    await h.respond([{ role: 1, content: "Generate a short title" }]);
    assert.equal(h.requestHeaders[0]["x-fantasy-reasoning-effort"], effort === "invalid" ? "none" : effort);
  });
}

test("a delta with both reasoning and answer emits thinking first", async () => {
  const h = harness();
  h.queuedDeltas.push([{ reasoning_content: "Plan", content: "Answer" }]);
  const parts = await h.respond();
  assert.ok(parts[0] instanceof ThinkingPart);
  assert.ok(parts[1] instanceof TextPart);
  assert.equal(parts[0].value, "Plan");
  assert.equal(parts[1].value, "Answer");
});

for (const settings of [{ showReasoning: false }, { nativeThinking: false }]) {
  test(`hidden/unavailable thinking preserves tool reasoning: ${JSON.stringify(settings)}`, async () => {
    const h = harness(settings);
    h.queuedDeltas.push([
      { reasoning_content: "Inspect file" },
      { tool_calls: [{ index: 0, id: "call-1", function: { name: "read_file", arguments: '{"path":"a.js"}' } }], finish_reason: "tool_calls" },
    ]);
    const parts = await h.respond();
    assert.equal(parts.length, 1);
    assert.ok(parts[0] instanceof ToolCallPart);
    assert.deepEqual(JSON.parse(JSON.stringify(parts[0].input)), { path: "a.js" });
    await h.respond([
      { role: 2, content: parts },
      { role: 1, content: [{ callId: "call-1", content: "file contents" }] },
    ]);
    assert.equal(h.requests[1].messages[1].reasoning_content, "Inspect file");
    assert.equal(h.requests[1].messages[1].content, "");
    assert.equal(h.requests[1].messages[2].role, "tool");
  });
}

test("native thinking history stays separate from answer text and tool calls", async () => {
  const h = harness();
  await h.respond([
    { role: 2, content: [new ThinkingPart(["Plan", " step"]), new TextPart("I will inspect"), new ToolCallPart("old-call", "read_file", { path: "a.js" })] },
    { role: 1, content: [{ callId: "old-call", content: "file contents" }] },
    { role: 2, content: [new ThinkingPart("Conclusion"), new TextPart("Previous answer")] },
  ]);
  const messages = h.requests[0].messages;
  assert.equal(messages[1].content, "I will inspect");
  assert.equal(messages[1].reasoning_content, "Plan step");
  assert.equal(messages[2].tool_call_id, "old-call");
  assert.equal(messages[3].content, "Previous answer");
  assert.equal(messages[3].reasoning_content, "Conclusion");
});
