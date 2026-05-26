# FantasyAI for Copilot

Use **FantasyAI** as a native language-model provider inside VS Code's Copilot Chat.

The extension connects to `https://fantasyai.cloud/api/v1` and exposes every FantasyAI model in the Copilot model picker — with streaming, tool calling, and vision where supported.

---

## Features

- **Hardcoded FantasyAI endpoint** — no setup beyond your API key
- **Native Copilot integration** — models appear in Copilot's Language Models picker
- **Auto model refresh** — model list updates on launch and every few minutes
- **Auto capability detection** — tool calling / vision detected from the gateway
- **Built-in chat panel** — optional standalone chat window
- **Secure key storage** — API key kept in VS Code's encrypted SecretStorage
- **Streaming responses** — real-time token streaming with stop button

---

## Quick start

1. Install the extension (`.vsix` or from the marketplace).
2. Open the Command Palette (`Ctrl+Shift+P`) → **FantasyAI: Set API Key**.
3. Paste your FantasyAI API key. Models are fetched automatically.
4. Pick a model from the Copilot model picker, or run **FantasyAI: Pick Model**.

That's it — no endpoint or provider configuration required.

---

## Commands

| Command | Description |
|---|---|
| `FantasyAI: Set API Key` | Save or update your FantasyAI API key |
| `FantasyAI: Clear API Key` | Remove the stored key |
| `FantasyAI: Pick Model` | Set the active FantasyAI model |
| `FantasyAI: Refresh Models` | Force a model-list refresh |
| `FantasyAI: Test Connection` | Verify the API is reachable |
| `FantasyAI: Open Chat` | Open the built-in chat panel |

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `fantasyAI.activeModel` | `""` | Currently active model |
| `fantasyAI.temperature` | `0.2` | Sampling temperature (0–2) |
| `fantasyAI.maxTokens` | `8192` | Maximum output tokens per response |
| `fantasyAI.contextWindow` | `128000` | Context window advertised to Copilot |
| `fantasyAI.systemPrompt` | `"You are a helpful…"` | System prompt |
| `fantasyAI.requestTimeoutMs` | `120000` | Request timeout (ms) |
| `fantasyAI.modelRefreshIntervalMs` | `300000` | Auto-refresh interval (ms, min 30s) |
| `fantasyAI.detection.timeoutMs` | `30000` | Per-model probe timeout (ms) |
| `fantasyAI.detection.concurrency` | `0` | Parallel probes (`0` = auto) |

The API key is **not** stored in `settings.json` — it lives in VS Code's encrypted SecretStorage.

---

## License

MIT
