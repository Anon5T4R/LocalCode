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

#[tauri::command]
fn search_files(
    root: String,
    query: String,
    case_sensitive: Option<bool>,
    use_regex: Option<bool>,
    whole_word: Option<bool>,
) -> Result<Vec<SearchMatch>, String> {
    let case_sensitive = case_sensitive.unwrap_or(false);
    let use_regex = use_regex.unwrap_or(false);
    let whole_word = whole_word.unwrap_or(false);

    let mut results = Vec::new();
    let mut dirs = vec![PathBuf::from(&root)];

    let re = if use_regex {
        Some(regex::Regex::new(&query).map_err(|e| format!("Regex inválida: {}", e))?)
    } else {
        None
    };

    while let Some(dir) = dirs.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name.starts_with('.') || name == "node_modules" || name == "target" {
                    continue;
                }
                dirs.push(path);
            } else if path.is_file() {
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                let binary = ["png", "jpg", "jpeg", "gif", "ico", "woff", "woff2", "ttf", "otf", "eot",
                    "pdf", "zip", "gz", "tar", "exe", "dll", "so", "dylib", "bin", "class"];
                if binary.contains(&ext) {
                    continue;
                }
                let content = match fs::read_to_string(&path) {
                    Ok(c) => c,
                    Err(_) => continue,
                };

                    let mut search_line = |line: &str, line_idx: usize| {
                    let (search_in, search_for) = if case_sensitive {
                        (line.to_string(), query.clone())
                    } else {
                        (line.to_lowercase(), query.to_lowercase())
                    };

                    if let Some(re) = &re {
                        for m in re.find_iter(&search_in) {
                            let col = m.start();
                            let end = m.end();
                            if whole_word {
                                let before = col > 0 && search_in.as_bytes().get(col - 1).map_or(false, |c| c.is_ascii_alphanumeric() || *c == b'_');
                                let after = search_in.as_bytes().get(end).map_or(false, |c| c.is_ascii_alphanumeric() || *c == b'_');
                                if before || after { continue; }
                            }
                            results.push(SearchMatch {
                                path: path.to_string_lossy().to_string(),
                                line: (line_idx + 1) as u32,
                                column: (col + 1) as u32,
                                line_content: line.to_string(),
                                match_start: col as u32,
                                match_end: end as u32,
                            });
                        }
                    } else {
                        let mut start = 0;
                        while let Some(col) = search_in[start..].find(&search_for) {
                            let abs_col = start + col;
                            let end = abs_col + query.len();
                            if whole_word {
                                let before = abs_col > 0 && search_in.as_bytes().get(abs_col - 1).map_or(false, |c| c.is_ascii_alphanumeric() || *c == b'_');
                                let after = search_in.as_bytes().get(end).map_or(false, |c| c.is_ascii_alphanumeric() || *c == b'_');
                                if before || after {
                                    start = abs_col + 1;
                                    continue;
                                }
                            }
                            results.push(SearchMatch {
                                path: path.to_string_lossy().to_string(),
                                line: (line_idx + 1) as u32,
                                column: (abs_col + 1) as u32,
                                line_content: line.to_string(),
                                match_start: abs_col as u32,
                                match_end: end as u32,
                            });
                            start = abs_col + 1;
                        }
                    }
                };

                for (i, line) in content.lines().enumerate() {
                    search_line(line, i);
                }
            }
        }
    }

    Ok(results)
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
        index.add_path(Path::new(p)).map_err(|e| format!("Falha ao adicionar '{}': {}", p, e))?;
    }
    index.write().map_err(|e| format!("Falha ao escrever index: {}", e))?;
    Ok(())
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
        commits.push(CommitEntry {
            hash: oid.to_string()[..7].to_string(),
            author: commit.author().name().unwrap_or("unknown").to_string(),
            message: commit.message().unwrap_or("").trim().to_string(),
            time: Utc::now().to_rfc3339(),
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

fn xor_cipher(data: &[u8]) -> Vec<u8> {
    data.iter().enumerate().map(|(i, b)| b ^ TOKEN_XOR_KEY[i % TOKEN_XOR_KEY.len()]).collect()
}

#[tauri::command]
fn github_set_token(app: tauri::AppHandle, token: String) -> Result<(), String> {
    let path = github_token_path(&app);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let encrypted = xor_cipher(token.as_bytes());
    fs::write(&path, encrypted).map_err(|e| format!("Erro salvando token: {}", e))?;
    Ok(())
}

#[tauri::command]
fn github_get_token(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = github_token_path(&app);
    if !path.exists() {
        return Ok(None);
    }
    let encrypted = fs::read(&path).map_err(|e| format!("Erro lendo token: {}", e))?;
    let decrypted = xor_cipher(&encrypted);
    let token = String::from_utf8(decrypted).map_err(|_| "Token corrompido".to_string())?;
    Ok(Some(token))
}

#[tauri::command]
fn github_remove_token(app: tauri::AppHandle) -> Result<(), String> {
    let path = github_token_path(&app);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Erro removendo token: {}", e))?;
    }
    Ok(())
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
fn git_pull(repo_path: String) -> Result<(), String> {
    let repo = git2::Repository::open(&repo_path)
        .map_err(|e| format!("Falha ao abrir repo: {}", e))?;

    let mut remote = repo.find_remote("origin")
        .map_err(|e| format!("Falha ao encontrar remote 'origin': {}", e))?;

    let mut callbacks = git2::RemoteCallbacks::new();
    callbacks.transfer_progress(|_progress| true);

    let mut fetch_opts = git2::FetchOptions::new();
    fetch_opts.remote_callbacks(callbacks);

    remote.fetch(&["refs/heads/*:refs/heads/*"], Some(&mut fetch_opts), None)
        .map_err(|e| format!("Falha ao fazer fetch: {}", e))?;

    let fetch_head = repo.find_reference("FETCH_HEAD")
        .map_err(|e| format!("Falha ao encontrar FETCH_HEAD: {}", e))?;
    let fetch_commit = fetch_head.peel_to_commit()
        .map_err(|e| format!("Falha ao peel FETCH_HEAD: {}", e))?;

    let head = repo.head().map_err(|e| format!("Falha ao ler HEAD: {}", e))?;
    let head_commit = head.peel_to_commit()
        .map_err(|e| format!("Falha ao peel HEAD: {}", e))?;

    let mut merge_opts = git2::MergeOptions::new();
    let annotated = repo.find_annotated_commit(fetch_commit.id())
        .map_err(|e| format!("Falha ao criar annotated commit: {}", e))?;
    repo.merge(&[&annotated], Some(&mut merge_opts), None)
        .map_err(|e| format!("Falha no merge: {}", e))?;

    if repo.index().map_err(|e| format!("Falha ao ler index: {}", e))?.has_conflicts() {
        return Err("Conflitos de merge detectados.".into());
    }

    let sig = git2::Signature::now("LocalCode", "localcode@local")
        .map_err(|e| format!("Falha ao criar signature: {}", e))?;
    let tree_oid = repo.index()
        .map_err(|e| format!("Falha ao ler index: {}", e))?
        .write_tree()
        .map_err(|e| format!("Falha ao escrever tree: {}", e))?;
    let tree = repo.find_tree(tree_oid)
        .map_err(|e| format!("Falha ao encontrar tree: {}", e))?;

    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        &format!("Merge pull from origin"),
        &tree,
        &[&head_commit, &fetch_commit],
    ).map_err(|e| format!("Falha ao commitar merge: {}", e))?;

    Ok(())
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
) -> Result<String, String> {
    manager.spawn(app).await
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
    let port: u16 = 8090;

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
        let ok = Command::new("where").arg(&cmd).output().is_ok();
        #[cfg(not(windows))]
        let ok = Command::new("which").arg(&cmd).output().is_ok();
        let _ = tx.send(ok);
    });
    rx.recv_timeout(Duration::from_millis(800)).unwrap_or(false)
}

#[tauri::command]
fn check_lsp_servers(app: tauri::AppHandle) -> Vec<LspServerStatus> {
    let rd = resolve_lsp_resource_dir(&app);
    vec![
        LspServerStatus {
            name: "typescript-language-server".into(),
            installed: lsp::check_bundled_lsp(&rd, "typescript-language-server")
                || check_command("typescript-language-server"),
            install_hint: "Embutido (offline)".into(),
        },
        LspServerStatus {
            name: "rust-analyzer".into(),
            installed: lsp::check_bundled_lsp(&rd, "rust-analyzer")
                || check_command("rust-analyzer"),
            install_hint: "Embutido (offline)".into(),
        },
        LspServerStatus {
            name: "pylsp".into(),
            installed: lsp::check_bundled_lsp(&rd, "pylsp")
                || check_command("pylsp"),
            install_hint: "Embutido (offline)".into(),
        },
        LspServerStatus {
            name: "gopls".into(),
            installed: lsp::check_bundled_lsp(&rd, "gopls")
                || check_command("gopls"),
            install_hint: "Embutido (offline)".into(),
        },
        LspServerStatus {
            name: "yaml-language-server".into(),
            installed: lsp::check_bundled_lsp(&rd, "yaml-language-server")
                || check_command("yaml-language-server"),
            install_hint: "Embutido (offline)".into(),
        },
        LspServerStatus {
            name: "vscode-html-language-server".into(),
            installed: lsp::check_bundled_lsp(&rd, "vscode-html-language-server")
                || check_command("vscode-html-language-server"),
            install_hint: "Embutido (offline)".into(),
        },
        LspServerStatus {
            name: "vscode-css-language-server".into(),
            installed: lsp::check_bundled_lsp(&rd, "vscode-css-language-server")
                || check_command("vscode-css-language-server"),
            install_hint: "Embutido (offline)".into(),
        },
        LspServerStatus {
            name: "vscode-json-language-server".into(),
            installed: lsp::check_bundled_lsp(&rd, "vscode-json-language-server")
                || check_command("vscode-json-language-server"),
            install_hint: "Embutido (offline)".into(),
        },
        LspServerStatus {
            name: "dart".into(),
            installed: lsp::check_bundled_lsp(&rd, "dart")
                || check_command("dart"),
            install_hint: "Embutido (offline)".into(),
        },
    ]
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
        .manage(Mutex::new(LlmState::default()))
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
            terminal_spawn,
            terminal_write,
            terminal_resize,
            terminal_kill,
            list_models,
            start_llm,
            stop_llm,
            llm_status,
            execute_terminal_command,
            check_lsp_servers,
            install_lsp_server,
            get_startup_file,
            exit_app,
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
            }
        });
}
