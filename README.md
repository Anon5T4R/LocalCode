# LocalCode

A lightweight, fast code editor built with [Tauri v2](https://v2.tauri.app/), React 19, and Rust.

## Features

- **Monaco Editor** — full VS Code editor experience (syntax highlight, autocomplete, multi-cursor)
- **LSP Integration** — intellisense for TypeScript, Rust, Python, Go, YAML, CSS, HTML, JSON
- **Debugger (DAP)** — zero-config F5 debugging for Python (debugpy), JavaScript/Node (js-debug), Rust and C/C++ (CodeLLDB); gutter breakpoints, variables, call stack, debug console — all local/offline
- **AI Assistant** — local LLM chat with tool-using agent (create/edit/read files, run terminal commands)
- **Git Integration** — stage, commit, push, pull, branch management, history
- **GitHub Integration** — authenticate, list repos, create repos, create PRs, clone
- **Terminal** — embedded xterm.js PTY terminal
- **File Explorer** — tree view with create/rename/delete
- **Search** — full-text search with regex and whole-word options
- **Document Outline** — symbol tree via LSP
- **LSP Setup** — one-click install for language servers

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production (Windows: NSIS installer)
npm run tauri build

# Build a Linux AppImage (run on Linux/WSL)
npm run tauri build -- --bundles appimage
```

> Os instaladores são gerados na plataforma correspondente: **NSIS (.exe)** no Windows e **AppImage** no Linux — não é possível gerar um AppImage a partir do Windows. O workflow `.github/workflows/build.yml` builda os dois (jobs `build-windows` e `build-linux`) e anexa ambos à release ao publicar uma tag `v*`.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Rust](https://rustup.rs/) >= 1.77
- System dependencies for [Tauri v2](https://v2.tauri.app/start/prerequisites/)

## AI Assistant Setup

1. Download a GGUF model (e.g., from Hugging Face)
2. Click the AI button in the toolbar
3. Set the folder containing `.gguf` files
4. Click "Procurar" to scan, then "Usar" on a model

`llama-server` is bundled with the release build (see `.github/workflows/build.yml`). In `npm run tauri dev`, place a `llama-server` binary in `src-tauri/binaries/llama/`.

## GitHub OAuth Setup

To use GitHub integration with device flow login:

1. Go to https://github.com/settings/developers and create a new OAuth App
2. Set "Homepage URL" to `http://localhost:1420` (or your app URL)
3. Set "Authorization callback URL" to `http://localhost:1420`
4. Copy the Client ID
5. In LocalCode Settings (⚙️), paste the Client ID into `githubClientId`

> O token é salvo no cofre de credenciais do SO (crate `keyring`). **No Linux** é preciso ter um Secret Service ativo (gnome-keyring/KWallet); sem ele, salvar o token falha com erro.
6. Click "Login with GitHub" — a code will appear. Press the link to open the device activation page, enter the code, and authorize.

> The official LocalCode OAuth app Client ID will be documented here when registered.

## Extension System

See [EXTENSIONS.md](EXTENSIONS.md) for the extension spec and [EXTENDING.md](EXTENDING.md) for a step-by-step tutorial.

## License

MIT
