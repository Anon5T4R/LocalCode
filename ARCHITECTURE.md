# LocalCode — Arquitetura

Editor de código desktop leve, construído com **Tauri v2** (backend Rust) + **React 19 / Vite** (frontend) e **Monaco** como editor. Tudo roda localmente: LSP, IA (via `llama-server`), Git e terminal. UI em português.

```
┌──────────────────────────────────────────────────────────────┐
│  Frontend (React/Vite)  ── src/                                │
│  ┌──────────┬─────────────────────────────┬────────────────┐  │
│  │ Sidebar  │  Editor (Monaco)            │  Side panel    │  │
│  │ Explorer │  + LSP providers            │  Git/GitHub/   │  │
│  │ Outline  │                             │  IA/LSP/Config │  │
│  │ Search   │  ── Terminal (xterm)        │  + extensões   │  │
│  └──────────┴─────────────────────────────┴────────────────┘  │
│        │  invoke()  +  listen()  (Tauri IPC)                   │
└────────┼──────────────────────────────────────────────────────┘
         ▼
┌──────────────────────────────────────────────────────────────┐
│  Backend (Rust)  ── src-tauri/src/                             │
│  lib.rs    FS · Git (git2) · GitHub (octocrab/reqwest) ·      │
│            busca · sessão · IA (llama-server) · LSP install    │
│  lsp.rs    LspManager: ciclo de vida + JSON-RPC dos servers   │
│  terminal.rs  TerminalManager: PTYs (portable-pty)            │
└──────────────────────────────────────────────────────────────┘
```

## Frontend (`src/`)

- **`App.tsx`** — componente raiz. Detém o estado global: abas (`Tab[]`), pasta raiz, visibilidade dos painéis, branch do git (polling 5s), posição do cursor. Responsável por: abrir/salvar/fechar abas, restaurar sessão na inicialização, interceptar o fechamento da janela (confirma abas sujas), auto-salvar a sessão (debounce 500ms) e os atalhos de teclado globais.
- **`editor/MonacoWrapper.tsx`** — embrulha `@monaco-editor/react`. Registra *uma vez* providers Monaco (`"*"` para todas as linguagens) que delegam ao LSP via backend: completion, hover, signature help, code action, definition, references, formatting (lêem o path atual via `pathRef`, pois o editor não remonta mais por aba). Usa `path` + `keepCurrentModel` → **um `ITextModel` por arquivo**, preservando undo/scroll/folding ao trocar de aba. `onChange` dispara `didChange` e aplica diagnósticos como markers. O tema segue `data-theme` via `MutationObserver`.
- **`editor/Breadcrumbs.tsx`** — barra acima do editor com os segmentos do caminho + a cadeia de símbolos (LSP `documentSymbols`) que envolve o cursor; clicar num símbolo navega até ele.
- **`explorer/FileExplorer.tsx`** — árvore de arquivos lazy (carrega filhos ao expandir). Criar/renomear/excluir + menu de contexto. `refreshSignal` (número incremental) força re-scan da raiz e das pastas expandidas.
- **`outline/OutlinePanel.tsx`** — símbolos do documento via LSP (`documentSymbols`).
- **`search/SearchPanel.tsx`** — busca full-text (regex / palavra inteira) delegada ao backend.
- **`git/GitPanel.tsx`** e **`github/GitHubPanel.tsx`** — UI de Git local e integração GitHub (device flow OAuth ou PAT, listar/criar repos, clonar, abrir PR).
- **`ai/`** — `AiPanel.tsx` (UI de chat/agente) + `agent.ts` (definição de ferramentas, system prompt, execução de ferramentas). Ver [Camada de IA](#camada-de-ia).
- **`terminal/TerminalPanel.tsx`** — múltiplos terminais em abas, cada um (`TerminalInstance`) com seu xterm.js + sessão PTY. Abre no `workspaceRoot`, roteia I/O por `session_id` e o tema segue o `data-theme`.
- **`palette/CommandPalette.tsx`** — paleta de comandos (`Ctrl+Shift+P`) e busca fuzzy de arquivos (`Ctrl+P`). Lista arquivos via `list_workspace_files` (respeita `.gitignore`); score por subsequência.
- **`settings/SettingsPanel.tsx`** — configurações persistidas em `localStorage` (`lib/settings.ts`).
- **`lsp-setup/LspSetupPanel.tsx`** — mostra quais language servers estão disponíveis (embutidos offline ou no PATH).
- **`lib/`** — wrappers finos de `invoke()` por domínio (`fs`, `git`, `github`, `lsp`, `ai`, `terminal`, `session`, `settings`, `search`, `path`) + `extension.ts` (ExtensionManager) e `monaco-setup.ts` (worker do Monaco).

### Modelo de abas
Cada `Tab` carrega `content` (buffer atual) e `savedContent`; `dirty = content !== savedContent`. Não há modelo Monaco por arquivo persistido — o `<Editor>` é remontado por aba (`key={tab.id}`).

## Backend (`src-tauri/src/`)

- **`lib.rs`** (~1300 linhas) — registra todos os comandos `#[tauri::command]`:
  - **FS:** `read_text_file`, `write_text_file` (cria diretórios pais), `list_dir`, `create_dir`, `delete_file`, `rename_file`.
  - **Busca:** `search_files` — varredura **paralela** (`ignore::WalkBuilder::build_parallel`) que respeita `.gitignore`, `.git/info/exclude` e pula binários; resultados ordenados para UI estável. `replace_in_files` substitui em massa (regex única cobrindo case/word/regex; `$` escapado em modo literal). `list_workspace_files` lista arquivos para o fuzzy finder.
  - **Git (git2):** `git_status`, `git_add` (stage add/remove), `git_unstage`, `git_discard`, `git_diff_file` (diff unificado staged/workdir), `git_commit`, `git_log`, `git_branches`, `git_checkout`, `git_push`, `git_pull` (fetch em `refs/remotes/origin/*` + fast-forward check; retorna mensagem descritiva ou erro se divergido).
  - **GitHub:** token persistido ofuscado com XOR (`.github_token.bin` em app_data); device flow (`github_device_login`/`github_poll_token`); octocrab para repos/PRs; clone via git2.
  - **IA:** `list_models` (varre `.gguf`), `start_llm`/`stop_llm`/`llm_status` (gerencia o processo `llama-server`; escolhe a **primeira porta livre em 8090–8099** via `find_free_port`), `execute_terminal_command` (usado pelo agente, com confirmação no front).
  - **LSP:** comandos `lsp_*` que delegam ao `LspManager`; `check_lsp_servers`/`install_lsp_server`.
  - **File-watching:** `watch_workspace(path)` inicia um `notify::RecommendedWatcher` recursivo (crate `notify` v6) e emite o evento Tauri `workspace-changed` ao frontend com debounce de 300 ms. `unwatch_workspace()` libera o watcher. O frontend (`App.tsx`) subscreve e incrementa `fileTreeVersion` para atualizar a árvore automaticamente.
  - **Sessão/app:** `save_session`/`load_session` (JSON em app_data), `get_startup_file`, `exit_app`, `get_extensions_dir`.
- **`lsp.rs`** (~1100 linhas) — `LspManager`: inicia processos de language server, faz handshake JSON-RPC LSP, mantém estado por linguagem e expõe os recursos. Suporta servers **embutidos** (`lsp-packages/`, offline-first) com fallback para o PATH.
- **`terminal.rs`** — `TerminalManager`: cria PTYs (`portable-pty`), faz streaming da saída via evento `terminal-output`, aceita input/resize/kill por `session_id`.
- **`main.rs`** — entrypoint que chama `code_lib::run()`.

### Ciclo de vida / janela
- Plugin `single-instance`: um segundo lançamento com um arquivo emite `open-file` e foca a janela existente.
- `CloseRequested` é interceptado (`prevent_close`) e emite `close-requested`; o front confirma abas sujas e chama `exit_app`.
- No `RunEvent::Exit`, mata o processo `llama-server` se estiver vivo.

## Camada de IA

Roda um modelo local GGUF via **`llama-server`** (API compatível com OpenAI em `127.0.0.1:8090`). Fluxo:

1. `AiPanel` lista modelos `.gguf` numa pasta e inicia o `llama-server` (`start_llm` com `ngl`/`ctx` das settings).
2. **Modo agente** (`agent.ts`): o system prompt instrui o modelo a responder com JSON `{"tool": ..., "args": ...}`. O painel também aceita `tool_calls` nativos do endpoint.
3. Ferramentas: `read_file`, `create_file`, `edit_file`, `delete_file`, `rename_file`, `list_dir`, `search_files`, `execute_command`.
   - Auto-executadas: leitura/criação/edição/rename/list/search.
   - **Requerem confirmação do usuário**: `delete_file` e `execute_command`.
4. Loop de até 10 rodadas: executa ferramentas, devolve os resultados como mensagem `user` e continua até o modelo parar de chamar ferramentas.
5. `streamChat` faz parse do SSE e separa `<think>...</think>` (raciocínio) do conteúdo.

> O system prompt é **fortemente enviesado para Rust** ("SEMPRE prefira Rust"). É uma escolha de produto deliberada; ajuste em `src/ai/agent.ts` se quiser um agente neutro.

## Sistema de extensões

`ExtensionManager` (`lib/extension.ts`) carrega pastas de extensão de dois lugares: `app_data/extensions/` e `<workspace>/.localcode/extensions/`. Cada extensão tem um `extension.json` que pode contribuir com `panels`, `languages` (mapeamento de extensão→Monaco/LSP), `commands` (com keybindings) e `themes` (variáveis CSS). Ver `EXTENSIONS.md` (spec) e `EXTENDING.md` (tutorial).

## Persistência

| Dado | Onde |
|------|------|
| Settings (tema, idioma, ngl/ctx, modelsDir, githubClientId) | `localStorage` (`localcode.settings`) |
| Sessão (abas, raiz, cursores) | `app_data/session.json` |
| Token GitHub | Cofre de credenciais do SO via crate `keyring` (Windows Credential Manager / macOS Keychain / Linux Secret Service). `.github_token.bin` legado é migrado e apagado no primeiro acesso. |
| llama-server baixado | `app_data/binaries/llama/` |

## Build e execução

```bash
npm install
npm run tauri dev                          # desenvolvimento
npm run tauri build                        # release (Windows → NSIS)
npm run tauri build -- --bundles appimage  # release (Linux → AppImage; rodar no Linux/WSL)
```

CI (`.github/workflows/build.yml`) tem dois jobs disparados por tags `v*`: **`build-windows`** (NSIS) e **`build-linux`** (AppImage em `ubuntu-22.04`). Cada um baixa as versões corretas (por SO) de `rust-analyzer`, `gopls`, Dart SDK e `llama-server`, marca os binários nativos como executáveis e os empacota como `resources` do bundle (`binaries/llama/**`, `lsp-packages/**`), resolvidos em runtime por `resolve_llama_server` / `resolve_lsp_resource_dir`. `find_bundled_lsp` (`lsp.rs`) resolve o nome do binário por plataforma (`.exe`/`.cmd` no Windows, sem sufixo no Unix). AppImage **não pode** ser gerado a partir do Windows. No Linux, `pylsp` não é embutido (sem Python embeddable) — usa o PATH.

Segurança/CSP (`tauri.conf.json`): `connect-src` permite `'self'` e `http://127.0.0.1:8090`–`8099` — a IA escolhe a primeira porta livre nessa faixa, então a CSP libera o intervalo inteiro.

## Pontos de atenção conhecidos

- **`execute_terminal_command`** executa comando arbitrário; a proteção é a confirmação no frontend. Mantê-la.
- Restauração de sessão + carregamento de extensões compartilham um `useEffect` com guarda `restored.current`; extensões de workspace dependem de `rootPath`, que pode estar `null` no primeiro mount.
- **Models do Monaco** ficam vivos por arquivo (`keepCurrentModel`) para preservar undo; abas fechadas não fazem `dispose()` do model, então há um vazamento de memória **limitado** ao número de arquivos abertos na sessão. Aceitável; se virar problema, descartar o model em `closeTab`.
