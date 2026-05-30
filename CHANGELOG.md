# Changelog

All notable changes to **FantasyAI for Copilot** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/).

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
