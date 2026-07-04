use chrono::Utc;
use serde::Serialize;
use std::fs;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

mod lsp;
use lsp::LspManager;

mod terminal;
use terminal::TerminalManager;

mod dap;
use dap::DapManager;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
}

#[derive(Serialize)]
struct StatusEntry {
    path: String,
    status: String,
    staged: bool,
}

#[derive(Serialize)]
struct CommitEntry {
    hash: String,
    author: String,
    message: String,
    time: String,
}

#[derive(Serialize)]
struct BranchEntry {
    name: String,
    current: bool,
}

#[derive(Serialize)]
struct RepoEntry {
    name: String,
    full_name: String,
    description: Option<String>,
    private: bool,
    url: String,
}

#[derive(Serialize)]
struct GithubPrResult {
    url: String,
    number: u64,
}

// ---------------------------------------------------------------------------
// File System
// ---------------------------------------------------------------------------

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Falha ao ler '{}': {}", path, e))
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Falha ao criar diretório '{}': {}", parent.display(), e))?;
        }
    }
    fs::write(&path, contents).map_err(|e| format!("Falha ao salvar '{}': {}", path, e))
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("'{}' não é um diretório", path));
    }
    let mut entries: Vec<FileEntry> = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| format!("Falha ao ler diretório: {}", e))? {
        let entry = entry.map_err(|e| format!("Erro ao ler entrada: {}", e))?;
        let meta = entry.metadata().map_err(|e| format!("Erro ao ler metadados: {}", e))?;
        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
            size: if meta.is_file() { meta.len() } else { 0 },
        });
    }
    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });
    Ok(entries)
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| format!("Falha ao criar diretório: {}", e))
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| format!("Falha ao remover diretório: {}", e))
    } else {
        fs::remove_file(p).map_err(|e| format!("Falha ao remover arquivo: {}", e))
    }
}

#[tauri::command]
fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    fs::rename(&old_path, &new_path).map_err(|e| format!("Falha ao renomear: {}", e))
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct SearchMatch {
    path: String,
    line: u32,
    column: u32,
    line_content: String,
    match_start: u32,
    match_end: u32,
}

const BINARY_EXT: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "ico", "woff", "woff2", "ttf", "otf", "eot",
    "pdf", "zip", "gz", "tar", "exe", "dll", "so", "dylib", "bin", "class",
    "wasm", "lock",
];

fn is_binary_path(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    BINARY_EXT.contains(&ext)
}

/// Collect every match of `query` within `content` into `out`.
fn search_in_content(
    path: &str,
    content: &str,
    re: &Option<regex::Regex>,
    query: &str,
    case_sensitive: bool,
    whole_word: bool,
    out: &mut Vec<SearchMatch>,
) {
    let search_for_lower = if case_sensitive { String::new() } else { query.to_lowercase() };

    for (line_idx, line) in content.lines().enumerate() {
        let (search_in, search_for) = if case_sensitive {
            (line.to_string(), query.to_string())
        } else {
            (line.to_lowercase(), search_for_lower.clone())
        };

        // Offsets are reported as CHARACTER indices (not bytes) so the frontend
        // can slice `line_content` correctly even with multibyte (e.g. accented) text.
        if let Some(re) = re {
            for m in re.find_iter(&search_in) {
                let col = m.start();
                let end = m.end();
                if whole_word {
                    let before = col > 0 && search_in.as_bytes().get(col - 1).map_or(false, |c| c.is_ascii_alphanumeric() || *c == b'_');
                    let after = search_in.as_bytes().get(end).map_or(false, |c| c.is_ascii_alphanumeric() || *c == b'_');
                    if before || after { continue; }
                }
                let char_start = search_in[..col].chars().count();
                let char_end = search_in[..end].chars().count();
                out.push(SearchMatch {
                    path: path.to_string(),
                    line: (line_idx + 1) as u32,
                    column: (char_start + 1) as u32,
                    line_content: line.to_string(),
                    match_start: char_start as u32,
                    match_end: char_end as u32,
                });
            }
        } else {
            let mut start = 0;
            while let Some(col) = search_in[start..].find(&search_for) {
                let abs_col = start + col;
                let end = abs_col + search_for.len();
                if whole_word {
                    let before = abs_col > 0 && search_in.as_bytes().get(abs_col - 1).map_or(false, |c| c.is_ascii_alphanumeric() || *c == b'_');
                    let after = search_in.as_bytes().get(end).map_or(false, |c| c.is_ascii_alphanumeric() || *c == b'_');
                    if before || after {
                        start = abs_col + 1;
                        continue;
                    }
                }
                let char_start = search_in[..abs_col].chars().count();
                let char_end = search_in[..end].chars().count();
                out.push(SearchMatch {
                    path: path.to_string(),
                    line: (line_idx + 1) as u32,
                    column: (char_start + 1) as u32,
                    line_content: line.to_string(),
                    match_start: char_start as u32,
                    match_end: char_end as u32,
                });
                start = abs_col + 1;
            }
        }
    }
}

#[tauri::command]
fn search_files(
    root: String,
    query: String,
    case_sensitive: Option<bool>,
    use_regex: Option<bool>,
    whole_word: Option<bool>,
) -> Result<Vec<SearchMatch>, String> {
    use ignore::WalkState;

    let case_sensitive = case_sensitive.unwrap_or(false);
    let use_regex = use_regex.unwrap_or(false);
    let whole_word = whole_word.unwrap_or(false);

    let re = if use_regex {
        Some(regex::Regex::new(&query).map_err(|e| format!("Regex inválida: {}", e))?)
    } else {
        None
    };

    let results = std::sync::Mutex::new(Vec::<SearchMatch>::new());

    ignore::WalkBuilder::new(&root)
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(false)
        .build_parallel()
        .run(|| {
            Box::new(|entry| {
                let entry = match entry {
                    Ok(e) => e,
                    Err(_) => return WalkState::Continue,
                };
                if !entry.file_type().map_or(false, |t| t.is_file()) {
                    return WalkState::Continue;
                }
                let path = entry.path();
                if is_binary_path(path) {
                    return WalkState::Continue;
                }
                let content = match fs::read_to_string(path) {
                    Ok(c) => c,
                    Err(_) => return WalkState::Continue,
                };
                let mut local = Vec::new();
                search_in_content(
                    &path.to_string_lossy(),
                    &content,
                    &re,
                    &query,
                    case_sensitive,
                    whole_word,
                    &mut local,
                );
                if !local.is_empty() {
                    results.lock().unwrap().extend(local);
                }
                WalkState::Continue
            })
        });

    let mut results = results.into_inner().unwrap();
    // Parallel walk yields nondeterministic order; sort for a stable UI.
    results.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)).then(a.column.cmp(&b.column)));
    Ok(results)
}

#[derive(Serialize)]
struct ReplaceResult {
    files_changed: u32,
    replacements: u32,
}

/// Replace all occurrences of `query` with `replacement` across the workspace,
/// honoring `.gitignore`. Returns counts of files changed and total replacements.
#[tauri::command]
fn replace_in_files(
    root: String,
    query: String,
    replacement: String,
    case_sensitive: Option<bool>,
    use_regex: Option<bool>,
    whole_word: Option<bool>,
) -> Result<ReplaceResult, String> {
    let case_sensitive = case_sensitive.unwrap_or(false);
    let use_regex = use_regex.unwrap_or(false);
    let whole_word = whole_word.unwrap_or(false);

    if query.is_empty() {
        return Err("A busca não pode estar vazia.".into());
    }

    // Build a single regex covering all modes so replacement is consistent.
    let mut pattern = if use_regex { query.clone() } else { regex::escape(&query) };
    if whole_word {
        pattern = format!(r"\b(?:{})\b", pattern);
    }
    let re = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| format!("Regex inválida: {}", e))?;

    // In literal mode, escape `$` so it is not treated as a capture reference.
    let repl = if use_regex { replacement.clone() } else { replacement.replace('$', "$$") };

    let mut files_changed = 0u32;
    let mut total = 0u32;

    for dir_entry in ignore::WalkBuilder::new(&root)
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(false)
        .build()
    {
        let entry = match dir_entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().map_or(false, |t| t.is_file()) {
            continue;
        }
        let path = entry.path();
        if is_binary_path(path) {
            continue;
        }
        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let count = re.find_iter(&content).count() as u32;
        if count == 0 {
            continue;
        }
        let new_content = re.replace_all(&content, repl.as_str());
        fs::write(path, new_content.as_ref())
            .map_err(|e| format!("Falha ao escrever '{}': {}", path.display(), e))?;
        files_changed += 1;
        total += count;
    }

    Ok(ReplaceResult { files_changed, replacements: total })
}

/// List every file under `root`, honoring `.gitignore`. Used by the fuzzy file
/// finder (command palette). Caps at `max` entries to stay responsive.
#[tauri::command]
fn list_workspace_files(root: String, max: Option<usize>) -> Result<Vec<String>, String> {
    let max = max.unwrap_or(10000);
    let mut files = Vec::new();
    for dir_entry in ignore::WalkBuilder::new(&root)
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(false)
        .build()
    {
        if files.len() >= max {
            break;
        }
        let entry = match dir_entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.file_type().map_or(false, |t| t.is_file()) {
            files.push(entry.path().to_string_lossy().to_string());
        }
    }
    Ok(files)
}

// ---------------------------------------------------------------------------
// File watching
// ---------------------------------------------------------------------------

/// Paths whose churn we don't care about: `node_modules`, build output, and the
/// `.git` internals — except `.git/HEAD`, which we keep so branch switches are
/// detected. Cuts down the event storms during installs, builds and git ops.
fn is_noise_path(p: &Path) -> bool {
    let s = p.to_string_lossy().replace('\\', "/");
    if s.ends_with("/.git/HEAD") || s.ends_with(".git/HEAD") {
        return false;
    }
    s.split('/').any(|seg| seg == "node_modules" || seg == "target" || seg == ".git")
}

struct WatcherState {
    watcher: Option<Box<dyn notify::Watcher + Send>>,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self { watcher: None }
    }
}

#[tauri::command]
async fn watch_workspace(
    app: tauri::AppHandle,
    path: String,
    state: tauri::State<'_, Mutex<WatcherState>>,
) -> Result<(), String> {
    use notify::{EventKind, Watcher, RecursiveMode, RecommendedWatcher, Config};
    use tokio::sync::mpsc;

    let (tx, mut rx) = mpsc::channel::<()>(64);

    let watcher = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                let relevant = matches!(
                    event.kind,
                    EventKind::Create(_)
                        | EventKind::Remove(_)
                        | EventKind::Modify(notify::event::ModifyKind::Name(_))
                );
                // Ignore events that only touch noise paths (node_modules, target, .git).
                let meaningful = event.paths.is_empty()
                    || event.paths.iter().any(|p| !is_noise_path(p));
                if relevant && meaningful {
                    let _ = tx.blocking_send(());
                }
            }
        },
        Config::default(),
    )
    .map_err(|e| format!("Falha ao criar watcher: {}", e))?;

    let mut watcher = watcher;
    watcher
        .watch(Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| format!("Falha ao monitorar pasta: {}", e))?;

    state.lock().unwrap().watcher = Some(Box::new(watcher));

    // Background task: debounce events and emit to frontend
    tokio::spawn(async move {
        loop {
            if rx.recv().await.is_none() {
                break;
            }
            // Drain any rapid follow-up events within 300 ms
            loop {
                match tokio::time::timeout(
                    std::time::Duration::from_millis(300),
                    rx.recv(),
                )
                .await
                {
                    Ok(Some(())) => {} // more events; keep draining
                    Ok(None) => return, // channel closed
                    Err(_) => break,   // timeout: no more events in window
                }
            }
            let _ = app.emit("workspace-changed", ());
        }
    });

    Ok(())
}

#[tauri::command]
fn unwatch_workspace(state: tauri::State<'_, Mutex<WatcherState>>) {
    state.lock().unwrap().watcher = None;
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

#[tauri::command]
fn git_status(repo_path: String) -> Result<Vec<StatusEntry>, String> {
    let repo = git2::Repository::open(&repo_path)
        .map_err(|e| format!("Falha ao abrir repo: {}", e))?;
    let mut entries: Vec<StatusEntry> = Vec::new();

    let mut status_opts = git2::StatusOptions::new();
    status_opts.include_untracked(true).recurse_untracked_dirs(true);

    let statuses = repo.statuses(Some(&mut status_opts))
        .map_err(|e| format!("Falha ao obter status: {}", e))?;

    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        let flags = entry.status();

        if flags.contains(git2::Status::CONFLICTED) {
            entries.push(StatusEntry { path: path.clone(), status: "conflicted".into(), staged: false });
        }
        if flags.is_index_new() {
            entries.push(StatusEntry { path: path.clone(), status: "added".into(), staged: true });
        }
        if flags.is_index_modified() || flags.is_index_typechange() {
            entries.push(StatusEntry { path: path.clone(), status: "modified".into(), staged: true });
        }
        if flags.is_index_deleted() {
            entries.push(StatusEntry { path: path.clone(), status: "deleted".into(), staged: true });
        }
        if flags.is_index_renamed() {
            entries.push(StatusEntry { path: path.clone(), status: "renamed".into(), staged: true });
        }
        if flags.is_wt_new() {
            entries.push(StatusEntry { path: path.clone(), status: "untracked".into(), staged: false });
        }
        if flags.is_wt_modified() || flags.is_wt_typechange() {
            entries.push(StatusEntry { path: path.clone(), status: "modified".into(), staged: false });
        }
        if flags.is_wt_deleted() {
            entries.push(StatusEntry { path: path.clone(), status: "deleted".into(), staged: false });
        }
        if flags.is_wt_renamed() {
            entries.push(StatusEntry { path: path.clone(), status: "renamed".into(), staged: false });
        }
    }
    Ok(entries)
}

#[tauri::command]
fn git_add(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    let repo = git2::Repository::open(&repo_path)
        .map_err(|e| format!("Falha ao abrir repo: {}", e))?;
    let mut index = repo.index().map_err(|e| format!("Falha ao abrir index: {}", e))?;
    for p in &paths {
        let full = Path::new(&repo_path).join(p);
        if full.exists() {
            index.add_path(Path::new(p)).map_err(|e| format!("Falha ao adicionar '{}': {}", p, e))?;
        } else {
            // File was deleted in the working tree — stage the removal
            index.remove_path(Path::new(p)).map_err(|e| format!("Falha ao remover '{}': {}", p, e))?;
        }
    }
    index.write().map_err(|e| format!("Falha ao escrever index: {}", e))?;
    Ok(())
}

/// Unstage a path (reset index entry to HEAD), keeping working-tree changes.
#[tauri::command]
fn git_unstage(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    let repo = git2::Repository::open(&repo_path)
        .map_err(|e| format!("Falha ao abrir repo: {}", e))?;
    match repo.head().ok().and_then(|h| h.peel_to_commit().ok()) {
        Some(head_commit) => {
            let obj = head_commit.as_object();
            let path_refs: Vec<&Path> = paths.iter().map(|p| Path::new(p)).collect();
            repo.reset_default(Some(obj), path_refs)
                .map_err(|e| format!("Falha ao remover do stage: {}", e))?;
        }
        None => {
            // No commits yet: just drop the entries from the index
            let mut index = repo.index().map_err(|e| format!("Falha ao abrir index: {}", e))?;
            for p in &paths {
                let _ = index.remove_path(Path::new(p));
            }
            index.write().map_err(|e| format!("Falha ao escrever index: {}", e))?;
        }
    }
    Ok(())
}

/// Discard working-tree changes for a path (checkout from HEAD/index).
#[tauri::command]
fn git_discard(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    let repo = git2::Repository::open(&repo_path)
        .map_err(|e| format!("Falha ao abrir repo: {}", e))?;
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.force();
    for p in &paths {
        checkout.path(p);
    }
    repo.checkout_head(Some(&mut checkout))
        .map_err(|e| format!("Falha ao descartar alterações: {}", e))?;
    Ok(())
}

/// Return a unified diff for a single file. When `staged` is true, diffs the
/// index against HEAD; otherwise diffs the working tree against the index.
#[tauri::command]
fn git_diff_file(repo_path: String, path: String, staged: bool) -> Result<String, String> {
    let repo = git2::Repository::open(&repo_path)
        .map_err(|e| format!("Falha ao abrir repo: {}", e))?;

    let mut diff_opts = git2::DiffOptions::new();
    diff_opts.pathspec(&path);
    diff_opts.include_untracked(true);
    diff_opts.recurse_untracked_dirs(true);

    let diff = if staged {
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut diff_opts))
            .map_err(|e| format!("Falha ao gerar diff: {}", e))?
    } else {
        repo.diff_index_to_workdir(None, Some(&mut diff_opts))
            .map_err(|e| format!("Falha ao gerar diff: {}", e))?
    };

    let mut out = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        match line.origin() {
            '+' | '-' | ' ' => out.push(line.origin()),
            _ => {}
        }
        out.push_str(&String::from_utf8_lossy(line.content()));
        true
    })
    .map_err(|e| format!("Falha ao formatar diff: {}", e))?;

    if out.is_empty() {
        out.push_str("(Sem alterações textuais — arquivo binário ou apenas modo/permissões)");
    }
    Ok(out)
}

#[tauri::command]
fn git_commit(repo_path: String, message: String) -> Result<(), String> {
    let repo = git2::Repository::open(&repo_path)
        .map_err(|e| format!("Falha ao abrir repo: {}", e))?;
    let sig = git2::Signature::now("LocalCode", "localcode@local")
        .map_err(|e| format!("Falha ao criar assinatura: {}", e))?;
    let mut index = repo.index().map_err(|e| format!("Falha ao abrir index: {}", e))?;
    let tree_oid = index.write_tree().map_err(|e| format!("Falha ao escrever tree: {}", e))?;
    let tree = repo.find_tree(tree_oid).map_err(|e| format!("Falha ao encontrar tree: {}", e))?;

    let parent = match repo.head() {
        Ok(head) => {
            let parent_oid = head.target().ok_or("HEAD sem target")?;
            Some(repo.find_commit(parent_oid).map_err(|e| format!("Falha ao encontrar parent: {}", e))?)
        }
        Err(_) => None,
    };

    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        &message,
        &tree,
        &parents,
    ).map_err(|e| format!("Falha ao commitar: {}", e))?;
    Ok(())
}

#[tauri::command]
fn git_log(repo_path: String, max: usize) -> Result<Vec<CommitEntry>, String> {
    let repo = git2::Repository::open(&repo_path)
        .map_err(|e| format!("Falha ao abrir repo: {}", e))?;
    let mut revwalk = repo.revwalk().map_err(|e| format!("Falha ao criar revwalk: {}", e))?;
    revwalk.push_head().map_err(|e| format!("Falha ao push head: {}", e))?;

    let mut commits = Vec::new();
    for (i, oid) in revwalk.enumerate() {
        if i >= max { break; }
        let oid = oid.map_err(|e| format!("Erro no revwalk: {}", e))?;
        let commit = repo.find_commit(oid).map_err(|e| format!("Commit não encontrado: {}", e))?;
        let time = chrono::DateTime::from_timestamp(commit.time().seconds(), 0)
            .map(|dt| dt.to_rfc3339())
            .unwrap_or_else(|| Utc::now().to_rfc3339());
        commits.push(CommitEntry {
            hash: oid.to_string()[..7].to_string(),
            author: commit.author().name().unwrap_or("unknown").to_string(),
            message: commit.message().unwrap_or("").trim().to_string(),
            time,
        });
    }
    Ok(commits)
}

#[tauri::command]
fn git_branches(repo_path: String) -> Result<Vec<BranchEntry>, String> {
    let repo = git2::Repository::open(&repo_path)
        .map_err(|e| format!("Falha ao abrir repo: {}", e))?;
    let mut branches = Vec::new();

    let current_head = repo.head().ok().and_then(|h| h.shorthand().map(|s| s.to_string()));

    let result = repo.branches(Some(git2::BranchType::Local));
    if let Ok(branch_iter) = result {
        for b in branch_iter.flatten() {
            let name = b.0.name().ok().flatten().unwrap_or("unknown").to_string();
            branches.push(BranchEntry {
                current: Some(name.clone()) == current_head,
                name,
            });
        }
    }
    Ok(branches)
}

#[tauri::command]
fn git_checkout(repo_path: String, branch: String) -> Result<(), String> {
    let repo = git2::Repository::open(&repo_path)
        .map_err(|e| format!("Falha ao abrir repo: {}", e))?;

    let obj = repo.revparse_single(&branch)
        .map_err(|e| format!("Falha ao resolver '{}': {}", branch, e))?;
    repo.checkout_tree(&obj, None)
        .map_err(|e| format!("Falha no checkout tree: {}", e))?;
    repo.set_head(&format!("refs/heads/{}", branch))
        .map_err(|e| format!("Falha ao set HEAD: {}", e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

fn github_token_path(app: &tauri::AppHandle) -> PathBuf {
    let mut path = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    path.push(".github_token.bin");
    path
}

const TOKEN_XOR_KEY: &[u8] = b"LocalCode2024!Secret@Key";

/// Legacy XOR decode, kept only to migrate old `.github_token.bin` files.
fn xor_cipher(data: &[u8]) -> Vec<u8> {
    data.iter().enumerate().map(|(i, b)| b ^ TOKEN_XOR_KEY[i % TOKEN_XOR_KEY.len()]).collect()
}

/// OS credential-store entry for the GitHub token (Windows Credential Manager /
/// macOS Keychain / Linux Secret Service).
fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("LocalCode", "github_token")
        .map_err(|e| format!("Erro ao acessar o cofre de credenciais: {}", e))
}

#[tauri::command]
fn github_set_token(app: tauri::AppHandle, token: String) -> Result<(), String> {
    let entry = keyring_entry()?;
    entry.set_password(&token).map_err(|e| format!("Erro salvando token: {}", e))?;
    // Drop any legacy obfuscated file now that the real secret store has it.
    let _ = fs::remove_file(github_token_path(&app));
    Ok(())
}

#[tauri::command]
fn github_get_token(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let entry = keyring_entry()?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => {
            // Migrate a legacy XOR-obfuscated file into the keychain, then delete it.
            let path = github_token_path(&app);
            if path.exists() {
                let encrypted = fs::read(&path).map_err(|e| format!("Erro lendo token: {}", e))?;
                if let Ok(token) = String::from_utf8(xor_cipher(&encrypted)) {
                    let _ = entry.set_password(&token);
                    let _ = fs::remove_file(&path);
                    return Ok(Some(token));
                }
            }
            Ok(None)
        }
        Err(e) => Err(format!("Erro lendo token: {}", e)),
    }
}

#[tauri::command]
fn github_remove_token(app: tauri::AppHandle) -> Result<(), String> {
    let entry = keyring_entry()?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(format!("Erro removendo token: {}", e)),
    }
    let _ = fs::remove_file(github_token_path(&app));
    Ok(())
}

#[derive(Serialize)]
struct DeviceFlowResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    interval: u64,
}

#[tauri::command]
async fn github_device_login(client_id: String) -> Result<DeviceFlowResponse, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[("client_id", client_id.as_str()), ("scope", "repo")])
        .send()
        .await
        .map_err(|e| format!("Erro ao iniciar login: {}", e))?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Erro ao ler resposta: {}", e))?;

    if let Some(err) = resp["error"].as_str() {
        return Err(resp["error_description"].as_str().unwrap_or(err).to_string());
    }

    Ok(DeviceFlowResponse {
        device_code: resp["device_code"].as_str().unwrap_or("").to_string(),
        user_code: resp["user_code"].as_str().unwrap_or("").to_string(),
        verification_uri: resp["verification_uri"].as_str().unwrap_or("").to_string(),
        interval: resp["interval"].as_u64().unwrap_or(5),
    })
}

#[tauri::command]
async fn github_poll_token(device_code: String, client_id: String) -> Result<String, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id.as_str()),
            ("device_code", device_code.as_str()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(|e| format!("Erro ao obter token: {}", e))?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Erro ao ler resposta: {}", e))?;

    if let Some(token) = resp["access_token"].as_str() {
        Ok(token.to_string())
    } else if resp["error"].as_str() == Some("authorization_pending") {
        Err("pending".to_string())
    } else if resp["error"].as_str() == Some("slow_down") {
        Err("slow_down".to_string())
    } else {
        Err(resp["error_description"].as_str().unwrap_or("erro desconhecido").to_string())
    }
}

fn get_octocrab(token: &str) -> octocrab::Octocrab {
    octocrab::OctocrabBuilder::new()
        .personal_token(token.to_string())
        .build()
        .expect("Falha ao criar cliente GitHub")
}

#[tauri::command]
async fn github_list_repos(token: String) -> Result<Vec<RepoEntry>, String> {
    let octocrab = get_octocrab(&token);
    let repos = octocrab
        .current()
        .list_repos_for_authenticated_user()
        .per_page(50)
        .send()
        .await
        .map_err(|e| format!("Erro ao listar repos: {}", e))?;

    Ok(repos
        .items
        .iter()
        .map(|r| RepoEntry {
            name: r.name.clone(),
            full_name: r.full_name.clone().unwrap_or_default(),
            description: r.description.clone(),
            private: r.private.unwrap_or(false),
            url: r.html_url.as_ref().map(|u| u.to_string()).unwrap_or_default(),
        })
        .collect())
}

#[tauri::command]
async fn github_create_repo(token: String, name: String, private: bool, description: String) -> Result<RepoEntry, String> {
    let octocrab = get_octocrab(&token);
    let repo: serde_json::Value = octocrab
        .post("/user/repos", Some(&serde_json::json!({
            "name": name,
            "private": private,
            "description": description,
        })))
        .await
        .map_err(|e| format!("Erro ao criar repo: {}", e))?;

    Ok(RepoEntry {
        name: repo["name"].as_str().unwrap_or("").to_string(),
        full_name: repo["full_name"].as_str().unwrap_or("").to_string(),
        description: repo["description"].as_str().map(|s| s.to_string()),
        private: repo["private"].as_bool().unwrap_or(false),
        url: repo["html_url"].as_str().unwrap_or("").to_string(),
    })
}

#[tauri::command]
async fn github_create_pr(
    token: String,
    owner: String,
    repo: String,
    title: String,
    body: String,
    head: String,
    base: String,
) -> Result<GithubPrResult, String> {
    let octocrab = get_octocrab(&token);
    let pr = octocrab
        .pulls(&owner, &repo)
        .create(title, head, base)
        .body(&body)
        .send()
        .await
        .map_err(|e| format!("Erro ao criar PR: {}", e))?;

    Ok(GithubPrResult {
        url: pr.html_url.map(|u| u.to_string()).unwrap_or_default(),
        number: pr.number,
    })
}

#[tauri::command]
async fn github_clone_repo(url: String, dest: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        git2::Repository::clone(&url, &dest)
            .map_err(|e| format!("Falha ao clonar repo: {}", e))
    })
    .await
    .map_err(|e| format!("Erro na thread: {}", e))?
    .map(|_| ())
}

#[tauri::command]
fn git_push(repo_path: String) -> Result<(), String> {
    let repo = git2::Repository::open(&repo_path)
        .map_err(|e| format!("Falha ao abrir repo: {}", e))?;

    let mut remote = repo.find_remote("origin")
        .map_err(|e| format!("Falha ao encontrar remote 'origin': {}", e))?;

    let mut callbacks = git2::RemoteCallbacks::new();
    callbacks.push_update_reference(|refname, status| {
        if let Some(msg) = status {
            Err(git2::Error::from_str(&format!("Push rejeitado em {}: {}", refname, msg)))
        } else {
            Ok(())
        }
    });

    let mut push_opts = git2::PushOptions::new();
    push_opts.remote_callbacks(callbacks);

    let head_ref = repo.head()
        .map_err(|e| format!("Falha ao ler HEAD: {}", e))?
        .name()
        .ok_or("HEAD sem nome")?
        .to_string();

    remote.push(&[&head_ref], Some(&mut push_opts))
        .map_err(|e| format!("Falha ao fazer push: {}", e))?;
    Ok(())
}

#[tauri::command]
fn git_pull(repo_path: String) -> Result<String, String> {
    let repo = git2::Repository::open(&repo_path)
        .map_err(|e| format!("Falha ao abrir repo: {}", e))?;

    let mut remote = repo.find_remote("origin")
        .map_err(|e| format!("Falha ao encontrar remote 'origin': {}", e))?;

    let mut callbacks = git2::RemoteCallbacks::new();
    callbacks.transfer_progress(|_progress| true);

    let mut fetch_opts = git2::FetchOptions::new();
    fetch_opts.remote_callbacks(callbacks);

    // Fetch into refs/remotes/origin/* — never overwrites local branches directly
    remote.fetch(&["+refs/heads/*:refs/remotes/origin/*"], Some(&mut fetch_opts), None)
        .map_err(|e| format!("Falha ao fazer fetch: {}", e))?;

    let head = repo.head().map_err(|e| format!("Falha ao ler HEAD: {}", e))?;
    if !head.is_branch() {
        return Err("HEAD está em modo detached. Faça checkout de um branch antes de fazer pull.".into());
    }
    let branch_name = head.shorthand()
        .ok_or("Falha ao ler nome do branch")?
        .to_string();

    let remote_ref_name = format!("refs/remotes/origin/{}", branch_name);
    let remote_ref = repo.find_reference(&remote_ref_name)
        .map_err(|_| format!("Branch remoto 'origin/{}' não encontrado", branch_name))?;
    let remote_commit = remote_ref.peel_to_commit()
        .map_err(|e| format!("Falha ao ler commit remoto: {}", e))?;

    let annotated = repo.find_annotated_commit(remote_commit.id())
        .map_err(|e| format!("Falha ao criar annotated commit: {}", e))?;

    let (analysis, _) = repo.merge_analysis(&[&annotated])
        .map_err(|e| format!("Falha ao analisar merge: {}", e))?;

    if analysis.is_up_to_date() {
        return Ok("Já está atualizado.".into());
    }

    if analysis.is_fast_forward() {
        let local_ref_name = head.name()
            .ok_or("Falha ao ler ref do HEAD")?
            .to_string();
        let mut local_ref = repo.find_reference(&local_ref_name)
            .map_err(|e| format!("Falha ao encontrar ref local: {}", e))?;
        local_ref.set_target(remote_commit.id(), "pull: fast-forward")
            .map_err(|e| format!("Falha ao atualizar branch: {}", e))?;
        repo.set_head(&local_ref_name)
            .map_err(|e| format!("Falha ao atualizar HEAD: {}", e))?;
        repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))
            .map_err(|e| format!("Falha ao fazer checkout: {}", e))?;
        return Ok(format!("Fast-forward para origin/{}.", branch_name));
    }

    Err(format!(
        "O branch 'origin/{}' divergiu do local. Pull não é possível via fast-forward. Resolva manualmente com git merge ou git rebase.",
        branch_name
    ))
}

// ---------------------------------------------------------------------------
// LSP
// ---------------------------------------------------------------------------

use std::sync::Arc;

#[tauri::command]
async fn lsp_start(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<LspManager>>,
    language: String,
    workspace_root: String,
) -> Result<String, String> {
    let rd = resolve_lsp_resource_dir(&app);
    let (cmd, args) = lsp::resolve_command(&language, &rd)?;
    manager.start(language, workspace_root, cmd, args).await
}

#[tauri::command]
async fn lsp_stop(
    manager: tauri::State<'_, Arc<LspManager>>,
    language: String,
) -> Result<(), String> {
    manager.stop(&language).await
}

#[tauri::command]
async fn lsp_did_open(
    manager: tauri::State<'_, Arc<LspManager>>,
    language: String,
    file_path: String,
    content: String,
) -> Result<(), String> {
    manager.did_open(&language, &file_path, &content).await
}

#[tauri::command]
async fn lsp_did_change(
    manager: tauri::State<'_, Arc<LspManager>>,
    language: String,
    file_path: String,
    content: String,
    version: i32,
) -> Result<Vec<lsp::LspDiagnostic>, String> {
    manager.did_change(&language, &file_path, &content, version).await
}

#[tauri::command]
async fn lsp_did_close(
    manager: tauri::State<'_, Arc<LspManager>>,
    language: String,
    file_path: String,
) -> Result<(), String> {
    manager.did_close(&language, &file_path).await
}

#[tauri::command]
async fn lsp_completion(
    manager: tauri::State<'_, Arc<LspManager>>,
    language: String,
    file_path: String,
    line: u32,
    column: u32,
) -> Result<Vec<lsp::LspCompletion>, String> {
    manager.completion(&language, &file_path, line, column).await
}

#[tauri::command]
async fn lsp_hover(
    manager: tauri::State<'_, Arc<LspManager>>,
    language: String,
    file_path: String,
    line: u32,
    column: u32,
) -> Result<Option<lsp::LspHover>, String> {
    manager.hover(&language, &file_path, line, column).await
}

#[tauri::command]
async fn lsp_signature_help(
    manager: tauri::State<'_, Arc<LspManager>>,
    language: String,
    file_path: String,
    line: u32,
    column: u32,
) -> Result<Option<lsp::LspSignatureHelp>, String> {
    manager.signature_help(&language, &file_path, line, column).await
}

#[tauri::command]
async fn lsp_code_action(
    manager: tauri::State<'_, Arc<LspManager>>,
    language: String,
    file_path: String,
    line: u32,
    column: u32,
) -> Result<Vec<lsp::LspCodeAction>, String> {
    manager.code_action(&language, &file_path, line, column).await
}

#[tauri::command]
async fn lsp_go_to_definition(
    manager: tauri::State<'_, Arc<LspManager>>,
    language: String,
    file_path: String,
    line: u32,
    column: u32,
) -> Result<Option<lsp::LspLocation>, String> {
    manager.go_to_definition(&language, &file_path, line, column).await
}

#[tauri::command]
async fn lsp_find_references(
    manager: tauri::State<'_, Arc<LspManager>>,
    language: String,
    file_path: String,
    line: u32,
    column: u32,
) -> Result<Vec<lsp::LspLocation>, String> {
    manager.find_references(&language, &file_path, line, column).await
}

#[tauri::command]
async fn lsp_document_symbols(
    manager: tauri::State<'_, Arc<LspManager>>,
    language: String,
    file_path: String,
) -> Result<Vec<lsp::LspSymbol>, String> {
    manager.document_symbols(&language, &file_path).await
}

#[tauri::command]
async fn lsp_format_document(
    manager: tauri::State<'_, Arc<LspManager>>,
    language: String,
    file_path: String,
) -> Result<Vec<lsp::LspTextEdit>, String> {
    manager.format_document(&language, &file_path).await
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

#[tauri::command]
async fn terminal_spawn(
    manager: tauri::State<'_, Arc<TerminalManager>>,
    app: tauri::AppHandle,
    cwd: Option<String>,
    shell: Option<String>,
    args: Option<Vec<String>>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<String, String> {
    manager.spawn(app, cwd, shell, args, env).await
}

// ---------------------------------------------------------------------------
// Debug Adapter Protocol
// ---------------------------------------------------------------------------

#[tauri::command]
async fn dap_start(
    manager: tauri::State<'_, Arc<DapManager>>,
    app: tauri::AppHandle,
    language: String,
) -> Result<dap::DapStartInfo, String> {
    let rd = resolve_lsp_resource_dir(&app);
    manager.start(app.clone(), &language, &rd).await
}

#[tauri::command]
async fn dap_connect(
    manager: tauri::State<'_, Arc<DapManager>>,
    app: tauri::AppHandle,
    port: u16,
) -> Result<dap::DapStartInfo, String> {
    manager.connect(app.clone(), port).await
}

#[tauri::command]
async fn dap_request(
    manager: tauri::State<'_, Arc<DapManager>>,
    session_id: String,
    command: String,
    arguments: Option<serde_json::Value>,
    timeout_ms: Option<u64>,
) -> Result<serde_json::Value, String> {
    manager
        .request(
            &session_id,
            &command,
            arguments.unwrap_or(serde_json::Value::Null),
            timeout_ms.unwrap_or(30_000),
        )
        .await
}

#[tauri::command]
async fn dap_respond(
    manager: tauri::State<'_, Arc<DapManager>>,
    session_id: String,
    request_seq: u64,
    command: String,
    success: bool,
    body: Option<serde_json::Value>,
) -> Result<(), String> {
    manager
        .respond(
            &session_id,
            request_seq,
            &command,
            success,
            body.unwrap_or(serde_json::Value::Null),
        )
        .await
}

#[tauri::command]
async fn dap_kill(
    manager: tauri::State<'_, Arc<DapManager>>,
    session_id: String,
) -> Result<(), String> {
    manager.kill(&session_id).await
}

#[derive(Serialize)]
struct DebugAdapterStatus {
    language: String,
    bundled: bool,
}

/// Which debug adapters ship with this install (for the debug panel hints).
#[tauri::command]
fn check_debug_adapters(app: tauri::AppHandle) -> Vec<DebugAdapterStatus> {
    let rd = resolve_lsp_resource_dir(&app);
    ["python", "javascript", "rust"]
        .iter()
        .map(|l| DebugAdapterStatus {
            language: l.to_string(),
            bundled: dap::check_bundled_adapter(&rd, l),
        })
        .collect()
}

#[tauri::command]
async fn terminal_write(
    manager: tauri::State<'_, Arc<TerminalManager>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    manager.write(&session_id, data).await
}

#[tauri::command]
async fn terminal_resize(
    manager: tauri::State<'_, Arc<TerminalManager>>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    manager.resize(&session_id, rows, cols).await
}

#[tauri::command]
async fn terminal_kill(
    manager: tauri::State<'_, Arc<TerminalManager>>,
    session_id: String,
) -> Result<(), String> {
    manager.kill(&session_id).await
}

#[tauri::command]
fn get_startup_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-') && Path::new(a).is_file())
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn get_extensions_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let ext_dir = dir.join("extensions");
    std::fs::create_dir_all(&ext_dir).map_err(|e| e.to_string())?;
    Ok(ext_dir.to_string_lossy().to_string())
}

#[tauri::command]
fn save_session(app: tauri::AppHandle, data: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("session.json"), &data).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_session(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("session.json");
    if path.exists() {
        std::fs::read_to_string(&path).map(Some).map_err(|e| e.to_string())
    } else {
        Ok(None)
    }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Local AI: llama-server lifecycle
// ---------------------------------------------------------------------------

#[derive(Default)]
struct LlmState {
    child: Option<Child>,
    port: u16,
    model: String,
}

#[derive(Serialize)]
struct ModelInfo {
    name: String,
    path: String,
    size_gb: f64,
    is_projector: bool,
}

#[derive(Serialize)]
struct LlmStatus {
    running: bool,
    port: u16,
    model: String,
}

fn collect_gguf(dir: &Path, base: &Path, out: &mut Vec<ModelInfo>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_gguf(&path, base, out);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("gguf"))
            .unwrap_or(false)
        {
            let file_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(ModelInfo {
                name: path.strip_prefix(base).unwrap_or(&path).to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
                size_gb: (size as f64) / 1_000_000_000.0,
                is_projector: file_name.to_lowercase().starts_with("mmproj"),
            });
        }
    }
}

const LLAMA_SERVER_BIN: &str = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };

fn resolve_llama_server(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let rel = format!("binaries/llama/{}", LLAMA_SERVER_BIN);
    let mut candidates: Vec<PathBuf> = Vec::new();
    // App data directory (where we download)
    candidates.push(llama_server_path(app));
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join(&rel));
    }
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join(&rel));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(&rel));
        }
    }
    // Dev mode: check relative to Cargo manifest dir
    #[cfg(debug_assertions)]
    {
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(&rel));
    }
    for c in &candidates {
        if c.exists() {
            return Ok(c.clone());
        }
    }
    Err("llama-server não encontrado (runtime de IA ausente). Use o modo debug ou instale em binaries/llama/".into())
}

fn wait_for_port(port: u16, secs: u64) -> Result<(), String> {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let attempts = secs * 4;
    for _ in 0..attempts {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err("llama-server não respondeu a tempo".into())
}

#[tauri::command]
fn list_models(dir: String) -> Result<Vec<ModelInfo>, String> {
    let base = PathBuf::from(&dir);
    if !base.exists() {
        return Err(format!("Pasta de modelos não encontrada: {}", dir));
    }
    let mut out = Vec::new();
    collect_gguf(&base, &base, &mut out);
    out.sort_by(|a, b| a.size_gb.partial_cmp(&b.size_gb).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out)
}

/// Return the first port in `[start, end]` that can be bound on localhost.
fn find_free_port(start: u16, end: u16) -> Option<u16> {
    (start..=end).find(|p| std::net::TcpListener::bind(("127.0.0.1", *p)).is_ok())
}

#[tauri::command]
fn start_llm(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<LlmState>>,
    model_path: String,
    n_gpu_layers: i32,
    ctx_size: u32,
) -> Result<u16, String> {
    {
        let mut s = state.lock().map_err(|_| "estado da IA corrompido")?;
        if let Some(child) = s.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        s.child = None;
    }

    let exe = resolve_llama_server(&app)?;
    let dir = exe.parent().ok_or("diretório do llama inválido")?.to_path_buf();
    // Pick the first free port in the range whitelisted by the CSP (8090-8099).
    let port = find_free_port(8090, 8099)
        .ok_or("Nenhuma porta livre entre 8090 e 8099 para a IA")?;

    let mut cmd = Command::new(&exe);
    cmd.current_dir(&dir).args([
        "--model",
        &model_path,
        "--host",
        "127.0.0.1",
        "--port",
        &port.to_string(),
        "-ngl",
        &n_gpu_layers.to_string(),
        "-c",
        &ctx_size.to_string(),
        "--no-webui",
    ]);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("falha ao iniciar llama-server: {}", e))?;

    {
        let mut s = state.lock().map_err(|_| "estado da IA corrompido")?;
        s.child = Some(child);
        s.port = port;
        s.model = model_path;
    }

    wait_for_port(port, 180)?;
    Ok(port)
}

#[tauri::command]
fn stop_llm(state: tauri::State<'_, Mutex<LlmState>>) -> Result<(), String> {
    let mut s = state.lock().map_err(|_| "estado da IA corrompido")?;
    if let Some(child) = s.child.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
    }
    s.child = None;
    s.model.clear();
    Ok(())
}

#[tauri::command]
fn llm_status(state: tauri::State<'_, Mutex<LlmState>>) -> LlmStatus {
    let mut s = state.lock().expect("estado da IA");
    let running = match s.child.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(None)),
        None => false,
    };
    LlmStatus {
        running,
        port: s.port,
        model: s.model.clone(),
    }
}

fn llama_server_path(app: &tauri::AppHandle) -> PathBuf {
    let mut p = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    p.push("binaries");
    p.push("llama");
    let _ = fs::create_dir_all(&p);
    p.push(LLAMA_SERVER_BIN);
    p
}

// ---------------------------------------------------------------------------
// Agent: execute a terminal command (with user confirmation in frontend)
// ---------------------------------------------------------------------------

#[tauri::command]
fn execute_terminal_command(command: String) -> Result<String, String> {
    let output = if cfg!(windows) {
        Command::new("cmd").args(["/C", &command]).output()
    } else {
        Command::new("sh").args(["-c", &command]).output()
    }
    .map_err(|e| format!("Falha ao executar comando: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(if stdout.is_empty() { stderr } else { stdout })
    } else {
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

// ---------------------------------------------------------------------------
// Bundled LSP resource helpers
// ---------------------------------------------------------------------------

/// Resolve the resource directory for bundled LSP servers.
/// Checks (in order): Tauri resource dir, current exe parent, dev fallback.
fn resolve_lsp_resource_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(rd) = app.path().resource_dir() {
        if rd.join("lsp-packages").exists() {
            return rd;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if dir.join("lsp-packages").exists() {
                return dir.to_path_buf();
            }
        }
    }
    #[cfg(debug_assertions)]
    {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if dev.join("lsp-packages").exists() {
            return dev;
        }
    }
    PathBuf::new()
}

// ---------------------------------------------------------------------------
// LSP server detection & installation (offline-first)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct LspServerStatus {
    name: String,
    installed: bool,
    install_hint: String,
}

fn check_command(cmd: &str) -> bool {
    let cmd = cmd.to_owned();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        #[cfg(windows)]
        let ok = Command::new("where").arg(&cmd).output().map(|o| o.status.success()).unwrap_or(false);
        #[cfg(not(windows))]
        let ok = Command::new("which").arg(&cmd).output().map(|o| o.status.success()).unwrap_or(false);
        let _ = tx.send(ok);
    });
    rx.recv_timeout(Duration::from_millis(800)).unwrap_or(false)
}

#[tauri::command]
async fn check_lsp_servers(app: tauri::AppHandle) -> Vec<LspServerStatus> {
    let rd = resolve_lsp_resource_dir(&app);
    let servers: Vec<(&str, &str)> = vec![
        ("typescript-language-server", "typescript-language-server"),
        ("rust-analyzer", "rust-analyzer"),
        ("pylsp", "pylsp"),
        ("gopls", "gopls"),
        ("yaml-language-server", "yaml-language-server"),
        ("vscode-html-language-server", "vscode-html-language-server"),
        ("vscode-css-language-server", "vscode-css-language-server"),
        ("vscode-json-language-server", "vscode-json-language-server"),
        ("dart", "dart"),
    ];

    let handles: Vec<_> = servers.into_iter().map(|(name, cmd)| {
        let rd = rd.clone();
        let name = name.to_owned();
        let cmd = cmd.to_owned();
        tokio::task::spawn_blocking(move || {
            let installed = lsp::check_bundled_lsp(&rd, &name) || check_command(&cmd);
            LspServerStatus { name, installed, install_hint: "Embutido (offline)".into() }
        })
    }).collect();

    let mut results = Vec::new();
    for h in handles {
        if let Ok(s) = h.await { results.push(s); }
    }
    results
}

/// Execute an install command — only used now for non-embedded LSPs (pylsp).
#[tauri::command]
fn install_lsp_server(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let rd = resolve_lsp_resource_dir(&app);
    // If the LSP is already bundled, short-circuit
    if lsp::check_bundled_lsp(&rd, &name) {
        return Ok("Já incluído no pacote offline.".into());
    }
    let (cmd, args): (&str, Vec<&str>) = match name.as_str() {
        "typescript-language-server" => ("cmd", vec!["/c", "npm", "install", "-g", "typescript-language-server"]),
        "rust-analyzer" => ("rustup", vec!["component", "add", "rust-analyzer"]),
        "pylsp" => ("pip", vec!["install", "python-lsp-server"]),
        "gopls" => ("go", vec!["install", "golang.org/x/tools/gopls@latest"]),
        "yaml-language-server" => ("cmd", vec!["/c", "npm", "install", "-g", "yaml-language-server"]),
        n if n.starts_with("vscode-") => ("cmd", vec!["/c", "npm", "install", "-g", "vscode-langservers-extracted"]),
        _ => return Err(format!("LSP '{}' desconhecido", name)),
    };

    let output = Command::new(cmd)
        .args(&args)
        .output()
        .map_err(|e| format!("Falha ao executar instalação: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(file) = argv.iter().skip(1).find(|a| Path::new(a).is_file()) {
                let _ = app.emit("open-file", file.clone());
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Arc::new(LspManager::new()))
        .manage(Arc::new(TerminalManager::new()))
        .manage(Arc::new(DapManager::new()))
        .manage(Mutex::new(LlmState::default()))
        .manage(Mutex::new(WatcherState::default()))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("close-requested", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            write_text_file,
            list_dir,
            create_dir,
            delete_file,
            rename_file,
            git_status,
            git_add,
            git_unstage,
            git_discard,
            git_diff_file,
            git_commit,
            git_log,
            git_branches,
            git_checkout,
            git_push,
            git_pull,
            github_set_token,
            github_get_token,
            github_remove_token,
            github_list_repos,
            github_create_repo,
            github_create_pr,
            github_clone_repo,
            github_device_login,
            github_poll_token,
            lsp_start,
            lsp_stop,
            lsp_did_open,
            lsp_did_change,
            lsp_did_close,
            lsp_completion,
            lsp_hover,
            lsp_signature_help,
            lsp_code_action,
            lsp_go_to_definition,
            lsp_find_references,
            lsp_document_symbols,
            lsp_format_document,
            search_files,
            replace_in_files,
            list_workspace_files,
            watch_workspace,
            unwatch_workspace,
            terminal_spawn,
            terminal_write,
            terminal_resize,
            terminal_kill,
            dap_start,
            dap_connect,
            dap_request,
            dap_respond,
            dap_kill,
            check_debug_adapters,
            list_models,
            start_llm,
            stop_llm,
            llm_status,
            execute_terminal_command,
            check_lsp_servers,
            install_lsp_server,
            get_startup_file,
            exit_app,
            get_extensions_dir,
            save_session,
            load_session,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<Mutex<LlmState>>() {
                    if let Ok(mut s) = state.lock() {
                        if let Some(child) = s.child.as_mut() {
                            let _ = child.kill();
                        }
                    }
                }
                if let Some(dap) = app_handle.try_state::<Arc<DapManager>>() {
                    let dap = dap.inner().clone();
                    tauri::async_runtime::block_on(async move { dap.kill_all().await });
                }
            }
        });
}
