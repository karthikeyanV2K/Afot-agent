# AFOT CLI (All For One Tech)

<p align="center">
  <strong>The Universal, Privacy-First Terminal AI Agent</strong><br>
  Built by <strong>All For One Tech (AFOT)</strong>
</p>

---

## ⚡ Overview

**AFOT CLI** is a terminal-first developer agent built for performance, privacy, and flexibility. It pairs coding intelligence directly with your shell, file system, and developer tools, while supporting any OpenAI-compatible AI model backend.

### ✨ Key Highlights

- 🌐 **Universal Multi-Provider Support**: Seamlessly connect and switch between **OpenCode**, **Nvidia NIM**, **OpenRouter**, **Groq**, **DeepSeek**, **Anthropic**, **OpenAI**, **Ollama**, and custom OpenAI-compatible endpoints.
- 🎨 **Floating Model Catalog (`/model manage`)**: Sleek, borderless interactive dialog with live model search, provider grouping, custom integration connect (`Ctrl+A`), favorite pinning (`Ctrl+F`), and live quota reset timers.
- 🚀 **Foreground Execution & Live Streaming**: Commands stay in the foreground with full streaming output directly in the TUI—never hidden behind background execution.
- 🔒 **Privacy-First (Zero Telemetry)**: Clearcut and Google telemetry have been fully disabled. Automatic phone-home update checks are neutralized so your workflow and tokens remain strictly between you and your chosen providers.
- 🧠 **Dynamic Token Counting & Context Management**: Smart, code-aware token heuristics that accurately estimate payload sizes (including tool outputs, file reads, and multi-byte UTF-8) to ensure smooth context compaction.
- 🛠️ **Extensible Tooling & MCP**: Full support for Model Context Protocol (MCP) servers, agent skills, custom commands, and policy guardrails.

---

## 🚀 Quick Start

### Prerequisites

- **Node.js**: >= 20.0.0 (recommended `~20.19.0` or higher)
- **npm**: >= 10.0.0

### Installation & Development

```bash
# Clone the repository
git clone https://github.com/karthikeyanV2K/Afot-agent.git
cd Afot-agent

# Install dependencies
npm install

# Build all packages
npm run build

# Start the interactive AFOT CLI
npm run start
```

### Creating a Standalone Bundle

You can create a single bundled entry point for fast startup:

```bash
npm run bundle
node bundle/gemini.js
```

---

## ⚙️ Configuration & Providers

AFOT CLI stores provider settings in `~/.afot/afot-config.json` and authentication keys in `~/.afot/afot-auth.json`.

### Connecting Providers

Launch the interactive model switcher anytime inside the TUI:

```text
> /model manage
```

- Press <kbd>Ctrl+A</kbd> to add or update an API key for any provider (OpenCode, Nvidia, OpenRouter, Groq, DeepSeek, etc.).
- Press <kbd>Ctrl+F</kbd> to favorite or unfavorite any model.
- Filter models instantly by typing in the search bar.
- Use <kbd>↑</kbd> / <kbd>↓</kbd> or <kbd>Enter</kbd> to select and activate a model.

---

## ⌨️ Useful Commands

Inside the AFOT CLI session:

| Command | Action |
| :--- | :--- |
| `/model manage` | Open the interactive model catalog and provider selector |
| `/skills list` | View available agent skills |
| `/settings` | Open the AFOT CLI settings interface |
| `/help` | Display general help and slash commands |
| `/quit` or <kbd>Ctrl+C</kbd> | Exit the session |

---

## 🛠️ Project Structure

Monorepo architecture powered by npm workspaces:

- `packages/cli`: User-facing terminal UI built with React and Ink, input parsing, and interactive dialogs.
- `packages/core`: Core agent engine, multi-provider API orchestration, prompt construction, and tool execution.
- `packages/sdk`: Programmatic SDK for embedding AFOT CLI capabilities in applications.
- `packages/devtools`: Built-in network and console inspector.
- `packages/a2a-server`: Experimental Agent-to-Agent protocol server.
- `packages/test-utils`: Testing rig and shared test suites.

---

## 🧪 Testing & Validation

```bash
# Run unit tests
npm run test

# Run tests for a specific workspace
npm test -w @google/gemini-cli-core -- src/core/contentGenerator.test.ts
npm test -w @google/gemini-cli -- src/ui/components/ModelDialog.test.tsx

# Type checking
npm run typecheck

# Linting
npm run lint
```

---

## 📄 License

Licensed under the [Apache License, Version 2.0](LICENSE).
