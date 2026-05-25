<<<<<<< HEAD
# Personal OpenAI Chat — VS Code Extension

Connect VS Code to **any OpenAI-compatible endpoint** and use it as a native language model in Copilot Chat — no cloud lock-in.

Works with **Ollama**, **Deepseek**, **OpenRouter**, **Azure OpenAI**, **LM Studio**, **Kimi**, **GLM**, and any provider that speaks the OpenAI Chat Completions API.

---

## Features

- **Multiple providers** — configure as many endpoints as you need
- **Native Copilot integration** — models appear in VS Code's Language Models picker
- **Built-in chat panel** — lightweight webview for quick conversations
- **Secure key storage** — API keys in VS Code's encrypted `SecretStorage`
- **Auto model discovery** — fetches model list from `/models` endpoint
- **Status bar shortcut** — see active model and switch in one click
- **Streaming responses** — real-time token streaming with stop button

---

## Installation

### From source

```bash
# 1. Clone the repo
git clone https://github.com/yourname/personal-openai-chat
cd personal-openai-chat

# 2. Install dev dependencies (only needed for packaging)
npm install

# 3a. Run in Extension Development Host (for development)
#     Press F5 in VS Code

# 3b. Or package and install
npm run package          # produces personal-openai-chat-1.0.0.vsix
code --install-extension personal-openai-chat-1.0.0.vsix
```

---

## Quick Start

### 1. Configure a provider

Open the Command Palette (`Ctrl+Shift+P`) and run:

```
Personal OpenAI: Configure Provider
```

Enter:
- **Display name** — e.g. `Ollama Local`
- **Base URL** — e.g. `http://localhost:11434/v1`
- **API key** — leave empty for local providers

Models will be fetched automatically from `/models`. If that fails, enter them manually (comma-separated).

### 2. Open the chat panel

```
Personal OpenAI: Open Chat
```

Or click the model name in the status bar.

---

## Commands

| Command | Description |
|---|---|
| `Personal OpenAI: Open Chat` | Open the built-in chat panel |
| `Personal OpenAI: Configure Provider` | Add or edit a provider |
| `Personal OpenAI: Pick Model` | Switch the active provider / model |
| `Personal OpenAI: Test Connection` | Verify connectivity |
| `Personal OpenAI: Clear Saved API Key` | Delete a stored API key |

---

## Configuration

Settings are stored under `personalOpenAI.*` in VS Code settings.

| Setting | Default | Description |
|---|---|---|
| `personalOpenAI.providers` | `[]` | List of provider objects |
| `personalOpenAI.temperature` | `0.2` | Sampling temperature (0–2) |
| `personalOpenAI.maxTokens` | `4096` | Maximum output tokens |
| `personalOpenAI.systemPrompt` | `"You are a helpful coding assistant…"` | System prompt |
| `personalOpenAI.requestTimeoutMs` | `120000` | Request timeout (ms) |

### Provider object example

```json
"personalOpenAI.providers": [
  {
    "name": "Ollama Local",
    "endpoint": "http://localhost:11434/v1",
    "models": ["llama3.2", "qwen2.5-coder:7b"],
    "defaultModel": "qwen2.5-coder:7b",
    "toolCalling": true,
    "imageInput": false,
    "contextWindow": 128000
  }
]
```

> **Security:** Never put API keys directly in `settings.json` if it's committed to source control. Use the **Configure Provider** command instead — it stores keys in VS Code's encrypted SecretStorage.

---

## Providers tested

| Provider | Base URL |
|---|---|
| Ollama | `http://localhost:11434/v1` |
| LM Studio | `http://localhost:1234/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Deepseek | `https://api.deepseek.com/v1` |
| OpenAI | `https://api.openai.com/v1` |
| Azure OpenAI | `https://<resource>.openai.azure.com/openai/deployments/<deployment>` |

---

## License

MIT
=======
# FantasyAI-for-copilot
Pick Every FantasyAI Provider from the Copilot Chat model picker — and keep everything else Copilot already gives you.
>>>>>>> 9778e18 (initial commit)
