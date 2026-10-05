# FantasyAI for Copilot

Use **FantasyAI** as a native language-model provider inside VS Code's Copilot Chat.

The extension connects to `https://fantasyai.cloud/api/v1` and exposes its bundled FantasyAI chat catalog in the Copilot model picker — with streaming, tool calling, and vision where supported. Requires VS Code 1.116 or later and Copilot Chat.

---

## Features

- **Hardcoded FantasyAI endpoint** — no setup beyond your API key
- **Native Copilot integration** — models appear in Copilot's Language Models picker
- **Instant model catalog** — models and their capabilities are bundled with the extension
- **New models** — GPT 5.6 Sol, Terra and Astra, Claude Opus 5, Claude Sonnet 5, and Qwen 3.8 Flash
- **Native thinking** — reasoning streams into Copilot's collapsible thinking block
- **Secure key storage** — API key kept in VS Code's encrypted SecretStorage
- **Streaming responses** — real-time token streaming with stop button

---

## Quick start

1. Install the extension (`.vsix` or from the marketplace).
2. Open the Command Palette (`Ctrl+Shift+P`) → **FantasyAI: Set API Key**.
3. Paste your FantasyAI API key. The gateway connection is checked automatically.
4. Pick a model from the Copilot model picker, or run **FantasyAI: Pick Model**.

That's it — no endpoint or provider configuration required.

---

## Commands

| Command | Description |
|---|---|
| `FantasyAI: Set API Key` | Save or update your FantasyAI API key |
| `FantasyAI: Clear API Key` | Remove the stored key |
| `FantasyAI: Pick Model` | Set the active FantasyAI model |
| `FantasyAI: Refresh Models` | Reload the bundled model list and check the gateway connection |
| `FantasyAI: Test Connection` | Verify the API is reachable |

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `fantasyAI.activeModel` | `""` | Currently active model |
| `fantasyAI.temperature` | `0.2` | Sampling temperature (0–2) |
| `fantasyAI.maxTokens` | `8192` | Maximum output tokens per response |
| `fantasyAI.systemPrompt` | `"You are a helpful…"` | System prompt |
| `fantasyAI.requestTimeoutMs` | `120000` | Request timeout (ms) |
| `fantasyAI.showReasoning` | `true` | Show reasoning in Copilot's native thinking block |

The API key is **not** stored in `settings.json` — it lives in VS Code's encrypted SecretStorage.

Native thinking uses `LanguageModelThinkingPart`, following [DeepSeek V4 for Copilot](https://github.com/Vizards/deepseek-v4-for-copilot). This API is still proposed; when a host does not expose it, reasoning is hidden while answers and tool calls continue to work. Hiding reasoning also preserves it for tool continuations.

Model names and routing follow FantasyAI's catalog. Its GPT 5.6 Sol/Terra/Astra and Claude Opus 5 entries are FantasyAI display identities routed through DeepSeek V4 by the gateway.

---

## License

MIT
