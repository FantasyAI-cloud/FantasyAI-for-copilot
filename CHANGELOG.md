# Changelog

All notable changes to **FantasyAI for Copilot** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.3] — 2026-10-28

### Fixed
- Send an explicit reasoning budget for Copilot requests, including titles and summaries, so simple utility turns do not inherit a long server-side reasoning setting.

### Added
- `fantasyAI.reasoningEffort`, defaulting to `none`, to control generation separately from reasoning display.

## [1.1.2] — 2026-10-27

### Fixed
- Mark Copilot tool requests and continuations as native agent turns so the FantasyAI gateway does not synthesize unrelated file reads.
- Describe only the supplied tools instead of requiring a hardcoded task-list tool.

### Changed
- Keep the local API endpoint used for integration testing.

## [1.1.1]

### Changed
- Retrieve chat models, display names, capabilities, and token limits from the FantasyAI `/models` API instead of a bundled catalog.
- Cache model discovery for five minutes, reload on API key changes, and fetch immediately with **Refresh Models**.
- Preserve the last successful model list on refresh errors and exclude image/video generation models from Copilot Chat.
- Honor the model's API output limit when streaming responses.

## [1.1.0] — 2026-10-05

### Added
- GPT 5.6 Sol, Terra and Astra, Claude Opus 5, Claude Sonnet 5, and Qwen 3.8 Flash from the FantasyAI catalog.

### Changed
- Stream reasoning through `LanguageModelThinkingPart` for Copilot's native collapsible thinking UI.
- Preserve native thinking history as `reasoning_content`, including tool continuations.
- Require VS Code 1.116 or later. Hosts without the thinking API hide reasoning while preserving answers and tool calls.

## [1.0.0] — 2026-05-27

### Added
- Native Copilot Chat language-model provider backed by FantasyAI.
- Streaming responses with tool calling and reasoning support.
- Auto model refresh on activation and on a configurable interval.
- Automatic capability detection (tool calling / vision) via the gateway.
- Secure API key storage in VS Code's SecretStorage.
- Built-in chat panel as a standalone webview.
- Status bar shortcut to switch active model.
- Runtime fallback: disables tool calling on models that reject it.

### Configuration
- Single hardcoded endpoint — no per-provider setup required.
- API key managed through **FantasyAI: Set API Key** command.
