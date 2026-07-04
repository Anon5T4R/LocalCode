use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex, RwLock};
use tokio::time::{sleep, timeout, Duration};

// ---------------------------------------------------------------------------
// Debug Adapter Protocol client (transport layer).
//
// The protocol *logic* (initialize/launch/breakpoints/...) lives in the
// frontend (src/debug/). This module only speaks the wire format — the same
// `Content-Length` framing as LSP — over stdio or TCP, routes responses back
// to pending requests by `request_seq`, and forwards everything else
// (events and reverse requests) to the frontend as `dap-message` events.
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
pub struct DapMessage {
    pub session_id: String,
    pub message: Value,
}

#[derive(Clone, Serialize)]
pub struct DapExit {
    pub session_id: String,
}

#[derive(Serialize)]
pub struct DapStartInfo {
    pub session_id: String,
    pub adapter: String,
    /// TCP port the adapter listens on (used by multi-session adapters like
    /// js-debug, where child sessions open extra connections to the same port).
    pub port: Option<u16>,
}

type BoxedWriter = Box<dyn AsyncWrite + Send + Unpin>;
type BoxedReader = Box<dyn AsyncRead + Send + Unpin>;

struct DapSession {
    writer: Mutex<BoxedWriter>,
    next_seq: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    /// The adapter process. Owned by the session that spawned it; extra TCP
    /// connections to the same adapter (js-debug child sessions) hold None.
    child: Mutex<Option<Child>>,
}

impl DapSession {
    async fn send(&self, body: &Value) -> Result<(), String> {
        let body = serde_json::to_string(body).map_err(|e| e.to_string())?;
        let mut writer = self.writer.lock().await;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        writer
            .write_all(header.as_bytes())
            .await
            .map_err(|e| format!("Erro escrevendo header DAP: {}", e))?;
        writer
            .write_all(body.as_bytes())
            .await
            .map_err(|e| format!("Erro escrevendo body DAP: {}", e))?;
        writer
            .flush()
            .await
            .map_err(|e| format!("Erro no flush DAP: {}", e))?;
        Ok(())
    }

    async fn kill_child(&self) {
        if let Some(child) = self.child.lock().await.as_mut() {
            let _ = child.start_kill();
        }
    }
}

pub struct DapManager {
    sessions: Arc<RwLock<HashMap<String, Arc<DapSession>>>>,
    next_id: AtomicU64,
}

impl DapManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            next_id: AtomicU64::new(1),
        }
    }

    async fn get(&self, session_id: &str) -> Result<Arc<DapSession>, String> {
        self.sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| "Sessão de depuração não encontrada".to_string())
    }

    async fn register(
        &self,
        app: AppHandle,
        writer: BoxedWriter,
        reader: BoxedReader,
        child: Option<Child>,
    ) -> String {
        let session_id = format!("dap-{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let session = Arc::new(DapSession {
            writer: Mutex::new(writer),
            next_seq: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            child: Mutex::new(child),
        });
        self.sessions
            .write()
            .await
            .insert(session_id.clone(), session.clone());

        let sessions = self.sessions.clone();
        let sid = session_id.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(reader);
            loop {
                let msg = match read_dap_message(&mut reader).await {
                    Ok(m) => m,
                    Err(_) => break,
                };
                if msg.get("type").and_then(|t| t.as_str()) == Some("response") {
                    if let Some(rs) = msg.get("request_seq").and_then(|v| v.as_u64()) {
                        if let Some(tx) = session.pending.lock().await.remove(&rs) {
                            let _ = tx.send(msg);
                            continue;
                        }
                    }
                }
                // Events and reverse requests go to the frontend.
                let _ = app.emit(
                    "dap-message",
                    DapMessage { session_id: sid.clone(), message: msg },
                );
            }
            // Adapter went away: drop pending waiters, kill the process and
            // tell the frontend the session is over.
            session.pending.lock().await.clear();
            session.kill_child().await;
            sessions.write().await.remove(&sid);
            let _ = app.emit("dap-exit", DapExit { session_id: sid });
        });

        session_id
    }

    /// Spawn a debug adapter for `language` and open a session to it.
    pub async fn start(
        &self,
        app: AppHandle,
        language: &str,
        resource_dir: &Path,
    ) -> Result<DapStartInfo, String> {
        let adapter = resolve_adapter(language, resource_dir)?;

        let mut cmd = Command::new(&adapter.cmd);
        cmd.args(&adapter.args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }

        match adapter.transport {
            Transport::Stdio => {
                let mut child = cmd
                    .spawn()
                    .map_err(|e| format!("Falha ao iniciar adaptador '{}': {}", adapter.name, e))?;
                let stdin = child.stdin.take().ok_or("stdin do adaptador indisponível")?;
                let stdout = child.stdout.take().ok_or("stdout do adaptador indisponível")?;
                let session_id = self
                    .register(app, Box::new(stdin), Box::new(stdout), Some(child))
                    .await;
                Ok(DapStartInfo { session_id, adapter: adapter.name, port: None })
            }
            Transport::Tcp(port) => {
                // TCP adapters don't use their stdio for the protocol.
                cmd.stdin(std::process::Stdio::null());
                cmd.stdout(std::process::Stdio::null());
                let child = cmd
                    .spawn()
                    .map_err(|e| format!("Falha ao iniciar adaptador '{}': {}", adapter.name, e))?;
                let stream = connect_with_retry(port).await.map_err(|e| {
                    format!("Adaptador '{}' não abriu a porta {}: {}", adapter.name, port, e)
                })?;
                let (r, w) = stream.into_split();
                let session_id = self
                    .register(app, Box::new(w), Box::new(r), Some(child))
                    .await;
                Ok(DapStartInfo { session_id, adapter: adapter.name, port: Some(port) })
            }
        }
    }

    /// Open an extra session to an already-running TCP adapter (js-debug
    /// child sessions started via the `startDebugging` reverse request).
    pub async fn connect(&self, app: AppHandle, port: u16) -> Result<DapStartInfo, String> {
        let stream = connect_with_retry(port)
            .await
            .map_err(|e| format!("Falha ao conectar na porta {}: {}", port, e))?;
        let (r, w) = stream.into_split();
        let session_id = self.register(app, Box::new(w), Box::new(r), None).await;
        Ok(DapStartInfo { session_id, adapter: "tcp".into(), port: Some(port) })
    }

    pub async fn request(
        &self,
        session_id: &str,
        command: &str,
        arguments: Value,
        timeout_ms: u64,
    ) -> Result<Value, String> {
        let session = self.get(session_id).await?;
        let seq = session.next_seq.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        session.pending.lock().await.insert(seq, tx);

        let body = json!({
            "seq": seq,
            "type": "request",
            "command": command,
            "arguments": arguments,
        });
        if let Err(e) = session.send(&body).await {
            session.pending.lock().await.remove(&seq);
            return Err(e);
        }

        match timeout(Duration::from_millis(timeout_ms), rx).await {
            Err(_) => {
                session.pending.lock().await.remove(&seq);
                Err(format!("Tempo esgotado aguardando resposta de '{}'", command))
            }
            Ok(Err(_)) => Err("A sessão de depuração foi encerrada".into()),
            Ok(Ok(msg)) => Ok(msg),
        }
    }

    /// Answer a reverse request (adapter → client), e.g. runInTerminal.
    pub async fn respond(
        &self,
        session_id: &str,
        request_seq: u64,
        command: &str,
        success: bool,
        body: Value,
    ) -> Result<(), String> {
        let session = self.get(session_id).await?;
        let seq = session.next_seq.fetch_add(1, Ordering::SeqCst);
        session
            .send(&json!({
                "seq": seq,
                "type": "response",
                "request_seq": request_seq,
                "command": command,
                "success": success,
                "body": body,
            }))
            .await
    }

    pub async fn kill(&self, session_id: &str) -> Result<(), String> {
        if let Some(session) = self.sessions.write().await.remove(session_id) {
            session.pending.lock().await.clear();
            session.kill_child().await;
        }
        Ok(())
    }

    /// Kill every adapter process (app shutdown).
    pub async fn kill_all(&self) {
        let mut sessions = self.sessions.write().await;
        for (_, session) in sessions.drain() {
            session.kill_child().await;
        }
    }
}

async fn read_dap_message<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
) -> Result<Value, String> {
    let mut content_length: usize = 0;
    loop {
        let mut line = String::new();
        let n = reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("Erro lendo header DAP: {}", e))?;
        if n == 0 {
            return Err("EOF".into());
        }
        let line = line.trim();
        if line.is_empty() {
            break;
        }
        if let Some(len) = line.strip_prefix("Content-Length: ") {
            content_length = len
                .parse::<usize>()
                .map_err(|e| format!("Content-Length inválido: {}", e))?;
        }
    }
    if content_length == 0 {
        return Err("Content-Length zero".into());
    }
    let mut buf = vec![0u8; content_length];
    reader
        .read_exact(&mut buf)
        .await
        .map_err(|e| format!("Erro lendo body DAP: {}", e))?;
    serde_json::from_slice(&buf).map_err(|e| format!("Erro parseando DAP: {}", e))
}

async fn connect_with_retry(port: u16) -> Result<TcpStream, String> {
    let mut last_err = String::new();
    for _ in 0..50 {
        match TcpStream::connect(("127.0.0.1", port)).await {
            Ok(stream) => {
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Err(e) => {
                last_err = e.to_string();
                sleep(Duration::from_millis(100)).await;
            }
        }
    }
    Err(last_err)
}

// ---------------------------------------------------------------------------
// Adapter resolution — bundled resources first (offline), then PATH.
// ---------------------------------------------------------------------------

enum Transport {
    Stdio,
    Tcp(u16),
}

struct AdapterLaunch {
    name: String,
    cmd: String,
    args: Vec<String>,
    transport: Transport,
}

/// Ask the OS for a free ephemeral port.
fn free_port() -> Result<u16, String> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| format!("Sem porta livre para o adaptador: {}", e))
}

fn exe_name(name: &str) -> String {
    if cfg!(windows) { format!("{}.exe", name) } else { name.to_string() }
}

/// Probe PATH interpreters for one that can `import debugpy`. Falls back to
/// the conventional name so the launch error (with the pip hint) is clear.
fn find_python_with_debugpy() -> String {
    let candidates: &[&str] = if cfg!(windows) {
        &["python", "py", "python3"]
    } else {
        &["python3", "python"]
    };
    for c in candidates {
        let c = c.to_string();
        let (tx, rx) = std::sync::mpsc::channel();
        let probe = c.clone();
        std::thread::spawn(move || {
            let mut cmd = std::process::Command::new(&probe);
            cmd.args(["-c", "import debugpy"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000);
            }
            let ok = cmd.status().map(|s| s.success()).unwrap_or(false);
            let _ = tx.send(ok);
        });
        if rx.recv_timeout(std::time::Duration::from_secs(4)).unwrap_or(false) {
            return c;
        }
    }
    if cfg!(windows) { "python".into() } else { "python3".into() }
}

fn resolve_adapter(language: &str, resource_dir: &Path) -> Result<AdapterLaunch, String> {
    match language {
        "python" | "py" => {
            // Reuse the embedded Python that already ships pylsp (Windows);
            // elsewhere probe the system interpreters for debugpy.
            let bundled = resource_dir.join("lsp-packages/python/python.exe");
            let py = if cfg!(windows) && bundled.exists() {
                bundled.to_string_lossy().to_string()
            } else {
                find_python_with_debugpy()
            };
            Ok(AdapterLaunch {
                name: "debugpy".into(),
                cmd: py,
                args: vec!["-m".into(), "debugpy.adapter".into()],
                transport: Transport::Stdio,
            })
        }
        "javascript" | "typescript" | "js" | "ts" | "node" => {
            let server = resource_dir.join("lsp-packages/js-debug/src/dapDebugServer.js");
            if !server.exists() {
                return Err(
                    "Adaptador js-debug não encontrado. Ele é incluído nas versões instaladas do LocalCode; em desenvolvimento, baixe js-debug-dap para src-tauri/lsp-packages/js-debug.".into(),
                );
            }
            let port = free_port()?;
            Ok(AdapterLaunch {
                name: "js-debug".into(),
                cmd: "node".into(),
                args: vec![
                    server.to_string_lossy().to_string(),
                    port.to_string(),
                    "127.0.0.1".into(),
                ],
                transport: Transport::Tcp(port),
            })
        }
        "rust" | "rs" | "c" | "cpp" | "c++" | "h" | "hpp" => {
            let bundled = resource_dir.join(format!(
                "lsp-packages/codelldb/adapter/{}",
                exe_name("codelldb")
            ));
            let cmd = if bundled.exists() {
                bundled.to_string_lossy().to_string()
            } else {
                // PATH fallback (user-installed codelldb).
                "codelldb".to_string()
            };
            let port = free_port()?;
            Ok(AdapterLaunch {
                name: "codelldb".into(),
                cmd,
                args: vec!["--port".into(), port.to_string()],
                transport: Transport::Tcp(port),
            })
        }
        other => Err(format!("Depuração não suportada para '{}'", other)),
    }
}

/// Check whether a bundled debug adapter exists (for the setup panel).
pub fn check_bundled_adapter(resource_dir: &Path, language: &str) -> bool {
    match language {
        "python" => {
            cfg!(windows) && resource_dir.join("lsp-packages/python/python.exe").exists()
        }
        "javascript" => resource_dir.join("lsp-packages/js-debug/src/dapDebugServer.js").exists(),
        "rust" => resource_dir
            .join(format!("lsp-packages/codelldb/adapter/{}", exe_name("codelldb")))
            .exists(),
        _ => false,
    }
}
