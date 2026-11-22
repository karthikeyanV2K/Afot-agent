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

## 🚀 Installation & Getting Started

### Install globally via NPM

```bash
npm install -g afot-cli
```

Once installed, launch AFOT CLI from anywhere in your terminal:

```bash
afot
```

### Or run directly with NPX (zero install)

```bash
npx afot-cli
```

### Install from Source

```bash
git clone https://github.com/karthikeyanV2K/Afot-agent.git
cd Afot-agent
npm install
npm run build
cd packages/cli && npm link

# Now run:
afot
```

Alternatively, use the built-in bin wrapper in the root directory:
```bash
./bin/afot
# Or on Windows:
.\bin\afot.cmd
```

---

## ⚡ Key Highlights & Features

- **Interactive In-TUI Diffs with Instant Hotkeys**: Review code modifications with syntax highlighting and diff stats (`+added / -removed`), and act immediately without navigation:
  - <kbd>y</kbd> : Accept and apply changes once
  - <kbd>n</kbd> : Reject changes / suggest edits (<kbd>Esc</kbd>)
  - <kbd>a</kbd> : Approve for the remainder of the session
  - <kbd>e</kbd> : Open in your configured external editor
- **Instant One-Step Undo (`/undo`)**: Reverts both the last conversation turn and all file modifications made by the model in that turn with a single command. To open the interactive turn history picker, run `/undo list` or `/rewind`.
- **Multi-Provider AI Engine**: Native support for OpenCode, Nvidia API Catalog, OpenRouter, Groq, DeepSeek, Google Gemini, Ollama, and custom OpenAI-compatible endpoints with optional (opt-in) provider failover and token counting.
- **Zero Background Hiding**: Full real-time execution outputs rendered directly in the terminal interface.

---

## 🔒 Security Defaults & Safety Switches

AFOT is built so that nothing leaves your machine, and nothing executes, unless you turned it on. All switches live in `~/.afot/config.json` (or the matching environment variable, which wins):

| Setting | Env var | Default | What it controls |
| :--- | :--- | :--- | :--- |
| `failover` | `AFOT_FAILOVER=1` | **off** | When a request fails (429/5xx/timeout), re-send the **whole conversation** to another configured provider. Off means your code only goes to the provider you selected. 401/403/404 never trigger failover. |
| `pluginsEnabled` | `AFOT_PLUGINS=1` | **off** | Load JS plugins from `~/.afot/plugins` and `config.plugins`. Plugins run with your full privileges; files that are group/world-writable or owned by another user are refused. |
| `embeddedToolCalls` | `AFOT_EMBEDDED_TOOL_CALLS=0` | on | Recover tool calls that some models print as text (`<invoke>`, DSML, …). They are ignored whenever the request already contains such markup (e.g. a fetched web page), to block prompt injection. |
| — | `AFOT_REQUEST_TIMEOUT_MS` | 120000 | Timeout for non-streaming requests. |
| — | `AFOT_MAX_OUTPUT_TOKENS` | 16384 | Upper bound for `max_tokens`. |
| — | `AFOT_PATH_GUARD=off` | guard on | Disables the session-directory sandbox (not recommended). |

**Path guard:** file tools may only touch the session directory unless you approve ("Allow once / always"). With no interactive confirmation available, access outside the directory is **denied**. `~/.afot` itself needs an explicit grant even if it sits inside your project directory. **The `shell` tool is not path-sandboxed** — a shell command can touch anything your user can, so keep command approval on for untrusted work.

**Credentials:** `~/.afot/auth.json` and `config.json` are written atomically with mode `0600`. A corrupt `auth.json` makes AFOT stop with an error instead of silently replacing it.

**Workspace shell approval (fewer prompts).** By default every shell command asks. To run commands that stay inside the workspace without a prompt:

```
/permissions shell workspace     # on  (saved to ~/.afot/config.json)
/permissions shell ask           # off (default)
```

or `AFOT_SHELL_APPROVAL=workspace`, or `"shellApproval": "workspace"` in `config.json`. In `workspace` mode these **still ask**:

| Category | Examples |
| :--- | :--- |
| Deletes | `rm`, `rmdir`, `del`, `rd`, `Remove-Item`, any `Remove-*`/`Clear-*`/`Stop-*` cmdlet, `find -delete`, `git rm`, `docker rm`, `kubectl delete`, `npm uninstall` |
| Git history / discarding work | `git reset`, `revert`, `clean`, `restore`, `checkout -- .`, `rebase`, `push`, `stash drop`, `branch -D`, `commit --amend`, `git -c`, `git -C ..` |
| Outside the workspace | any argument or redirect target resolving outside it (`../x`, `/etc`, `~`, `C:\other`, symlinks that leave it), `cd ..`, `cd ~` |
| AFOT config | anything touching `~/.afot` |
| Privilege / remote / system | `sudo`, `ssh`, `scp`, `rsync`, `kill`, `dd`, `npm i -g`, `cargo install`, `Set-ExecutionPolicy` |
| Cannot be analysed | command substitution, loops, dynamic command names, odd quoting, `cmd.exe`, encoded PowerShell, `curl … \| sh` |

This mode also stops the "build file changed, ask again" prompt for `cargo`/`npm`/`make`. DENY rules and explicit per-command ASK rules still win, and it does nothing in untrusted folders.

**Limit:** this inspects the command *text*. `cargo test`, `npm test`, `python x.py` or `./run.sh` run their own code, which can delete or move anything. Real containment needs an OS sandbox.

---

## ⌨️ Useful Commands

Inside the AFOT CLI session:

| Command | Action |
| :--- | :--- |
| `/undo` | Immediately rollback the last turn and revert all file edits |
| `/rewind` | Jump back to any previous conversation turn interactively |
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

## 🙏 Attribution

AFOT CLI is a fork of [Gemini CLI](https://github.com/google-gemini/gemini-cli) by Google LLC, licensed under Apache-2.0. Modifications by All For One Tech include the multi-provider (OpenAI-compatible) engine, the Cline/Kilo/OpenCode bridges, the swarm orchestrator, the session path guard, and removal of Google telemetry. See [NOTICE](./NOTICE).

---

## 📄 License

Licensed under the [Apache License, Version 2.0](LICENSE).
