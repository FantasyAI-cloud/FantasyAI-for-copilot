# FantasyAI for Copilot

Use **FantasyAI** as a native language-model provider inside VS Code's Copilot Chat.

This local test build retrieves chat models from `http://localhost:3000/api/v1/models` and exposes them in the Copilot model picker — with streaming, tool calling, and vision where supported. Keep the local FantasyAI server running. Requires VS Code 1.116 or later and Copilot Chat.

---

## Features

- **Hardcoded FantasyAI endpoint** — no setup beyond your API key
- **Native Copilot integration** — models appear in Copilot's Language Models picker
- **Dynamic model catalog** — names, capabilities, and token limits come from the FantasyAI API, using your key to retrieve the models available to your plan
- **Cached discovery** — loads on startup, reuses results for five minutes, and checks for updates when the model list is requested after expiry
- **Native thinking** — reasoning streams into Copilot's collapsible thinking block
- **Secure key storage** — API key kept in VS Code's encrypted SecretStorage
- **Streaming responses** — real-time token streaming with stop button

---

## Quick start

1. Install the extension (`.vsix` or from the marketplace).
2. Open the Command Palette (`Ctrl+Shift+P`) → **FantasyAI: Set API Key**.
3. Paste your FantasyAI API key. The available models are fetched automatically.
4. Pick a model from the Copilot model picker, or run **FantasyAI: Pick Model**.

That's it — no endpoint or provider configuration required.

---

## Commands

| Command | Description |
|---|---|
| `FantasyAI: Set API Key` | Save or update your FantasyAI API key |
| `FantasyAI: Clear API Key` | Remove the stored key |
| `FantasyAI: Pick Model` | Set the active FantasyAI model |
| `FantasyAI: Refresh Models` | Fetch the latest model list from the API immediately |
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
| `fantasyAI.reasoningEffort` | `"none"` | Generation reasoning budget: `none`, `low`, `medium`, `high`, or `max`; higher values can increase latency |

The API key is **not** stored in `settings.json` — it lives in VS Code's encrypted SecretStorage.

Native thinking uses `LanguageModelThinkingPart`, following [DeepSeek V4 for Copilot](https://github.com/Vizards/deepseek-v4-for-copilot). This API is still proposed; when a host does not expose it, reasoning is hidden while answers and tool calls continue to work. Hiding reasoning also preserves it for tool continuations.

The model list uses the API's display names and routable IDs. Image and video generation models are excluded from Copilot Chat. Without an API key, the extension retrieves the public catalog; sending chat requests still requires a key. If a refresh fails, the last successfully fetched list remains available for the current session. Changing or clearing the key resets that cache.

---

## License

MIT
