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

function harness({ showReasoning = true, nativeThinking = true } = {}) {
  let provider;
  const requests = [];
  const queuedDeltas = [];
  const vscode = {
    LanguageModelTextPart: TextPart,
    LanguageModelThinkingPart: nativeThinking ? ThinkingPart : undefined,
    LanguageModelToolCallPart: ToolCallPart,
    EventEmitter: class { event() {} fire() {} },
    workspace: { getConfiguration: () => ({
      get: (key, fallback) => key === "showReasoning" ? showReasoning : fallback,
    }) },
    lm: { registerLanguageModelChatProvider: (_vendor, value) => { provider = value; return {}; } },
  };
  const context = { subscriptions: [], secrets: { get: async () => "test-key" } };
  const sandbox = {
    require: (name) => name === "vscode" ? vscode : require(name),
    module: { exports: {} }, context, Buffer, TextDecoder, AbortController,
    console: { log() {}, error() {} },
    fetch: async (_url, options) => {
      requests.push(JSON.parse(options.body));
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
    provider, requests, queuedDeltas,
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

test("new catalog entries use gateway IDs, capabilities and context budgets", async () => {
  const h = harness();
  const models = await h.provider.provideLanguageModelChatInformation();
  const expected = [
    ["gpt-5-6-sol", 131072, true], ["gpt-5-6-terra", 131072, true],
    ["gpt-5-6-astra", 131072, true], ["claude-opus-5", 1000000, true],
    ["claude-sonnet-5", 1000000, true], ["qwen3.8-flash", 262144, false],
  ];
  assert.equal(new Set(models.map(m => m.id)).size, models.length);
  for (const [id, context, vision] of expected) {
    const model = models.find(m => m.id === id);
    assert.ok(model, id);
    assert.equal(model.maxInputTokens, context);
    assert.equal(model.capabilities.imageInput, vision);
    assert.equal(model.capabilities.toolCalling, true);
    await h.respond([{ role: 1, content: "Hello" }], id);
    assert.equal(h.requests.at(-1).model, id);
  }
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
