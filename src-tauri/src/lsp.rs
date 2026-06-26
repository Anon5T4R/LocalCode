use lsp_types as lsp;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, RwLock};
use tokio::time::{timeout, Duration};

// ---------------------------------------------------------------------------
// Public types returned to the frontend
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct LspCompletion {
    pub label: String,
    pub kind: Option<String>,
    pub detail: Option<String>,
    pub documentation: Option<String>,
    pub insert_text: Option<String>,
}

#[derive(Serialize)]
pub struct LspHover {
    pub contents: Vec<String>,
    pub range: Option<[u32; 4]>,
}

#[derive(Serialize, Clone)]
pub struct LspSignatureHelp {
    pub signatures: Vec<LspSignatureInfo>,
    pub active_signature: i32,
    pub active_parameter: i32,
}

#[derive(Serialize, Clone)]
pub struct LspSignatureInfo {
    pub label: String,
    pub documentation: Option<String>,
    pub parameters: Vec<LspParameterInfo>,
}

#[derive(Serialize, Clone)]
pub struct LspParameterInfo {
    pub label: String,
    pub documentation: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct LspCodeAction {
    pub title: String,
    pub kind: Option<String>,
    pub diagnostics: Vec<usize>,
    pub is_preferred: bool,
}

#[derive(Serialize, Clone)]
pub struct LspLocation {
    pub uri: String,
    pub range: [u32; 4],
}

#[derive(Serialize, Clone)]
pub struct LspSymbol {
    pub name: String,
    pub kind: String,
    pub detail: Option<String>,
    pub range: [u32; 4],
    pub selection_range: [u32; 4],
    pub children: Vec<LspSymbol>,
}

#[derive(Serialize, Clone)]
pub struct LspTextEdit {
    pub range: [u32; 4],
    pub new_text: String,
}

#[derive(Serialize, Clone)]
pub struct LspDiagnostic {
    pub file_path: String,
    pub range: [u32; 4],
    pub severity: String,
    pub message: String,
    pub source: Option<String>,
    pub code: Option<String>,
}

#[derive(Serialize)]
pub struct LspStatus {
    pub running: bool,
    pub language: String,
    pub server_name: String,
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct JsonRpcResponse {
    #[serde(default)]
    id: Option<u64>,
    #[serde(default)]
    result: Option<serde_json::Value>,
    #[serde(default)]
    error: Option<JsonRpcError>,
    #[allow(dead_code)]
    #[serde(default)]
    method: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    params: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct JsonRpcError {
    code: i64,
    message: String,
}

// ---------------------------------------------------------------------------
// LSP client instance
// ---------------------------------------------------------------------------

pub struct LspManager {
    instances: RwLock<HashMap<String, Arc<Mutex<LspInstance>>>>,
}

impl LspManager {
    pub fn new() -> Self {
        Self {
            instances: RwLock::new(HashMap::new()),
        }
    }

    fn server_command(language: &str) -> Option<(&'static str, Vec<&'static str>)> {
        match language {
            "rust" | "rs" => Some(("rust-analyzer", vec![])),
            "python" | "py" => Some(("pylsp", vec![])),
            "go" => Some(("gopls", vec![])),
            "typescript" | "javascript" | "ts" | "tsx" | "js" | "jsx" => {
                Some(("typescript-language-server", vec!["--stdio"]))
            }
            "html" => Some(("vscode-html-language-server", vec!["--stdio"])),
            "css" => Some(("vscode-css-language-server", vec!["--stdio"])),
            "json" => Some(("vscode-json-language-server", vec!["--stdio"])),
            "yaml" | "yml" => Some(("yaml-language-server", vec!["--stdio"])),
            "dart" => Some(("dart", vec!["language-server", "--protocol=stdio"])),
            _ => None,
        }
    }

    async fn get_instance(&self, language: &str) -> Result<Arc<Mutex<LspInstance>>, String> {
        let instances = self.instances.read().await;
        instances
            .get(language)
            .cloned()
            .ok_or_else(|| format!("LSP não iniciado para '{}'", language))
    }

    pub async fn start(
        &self,
        language: String,
        workspace_root: String,
        cmd: String,
        args: Vec<String>,
    ) -> Result<String, String> {
        {
            let instances = self.instances.read().await;
            if instances.contains_key(&language) {
                return Ok(format!("LSP já iniciado para {}", language));
            }
        }

        let mut child = Command::new(&cmd)
            .args(&args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .current_dir(&workspace_root)
            .spawn()
            .map_err(|e| format!("Falha ao iniciar '{}': {}", cmd, e))?;

        let stdin = child.stdin.take().ok_or("stdin não disponível")?;
        let stdout = child.stdout.take().ok_or("stdout não disponível")?;
        let reader = BufReader::new(stdout);

        let instance = LspInstance {
            stdin: Mutex::new(stdin),
            reader: Mutex::new(reader),
            next_id: AtomicU64::new(1),
            server_name: cmd.to_string(),
        };

        let caps = lsp::ClientCapabilities {
            text_document: Some(lsp::TextDocumentClientCapabilities {
                completion: Some(lsp::CompletionClientCapabilities {
                    completion_item: Some(lsp::CompletionItemCapability {
                        snippet_support: Some(true),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                hover: Some(lsp::HoverClientCapabilities {
                    dynamic_registration: Some(false),
                    content_format: Some(vec![lsp::MarkupKind::Markdown]),
                }),
                signature_help: Some(lsp::SignatureHelpClientCapabilities {
                    dynamic_registration: Some(false),
                    signature_information: Some(lsp::SignatureInformationSettings {
                        documentation_format: Some(vec![lsp::MarkupKind::Markdown]),
                        parameter_information: Some(lsp::ParameterInformationSettings {
                            label_offset_support: Some(true),
                        }),
                        active_parameter_support: Some(true),
                    }),
                    context_support: Some(true),
                }),
                code_action: Some(lsp::CodeActionClientCapabilities {
                    dynamic_registration: Some(false),
                    code_action_literal_support: Some(lsp::CodeActionLiteralSupport {
                        code_action_kind: lsp::CodeActionKindLiteralSupport {
                            value_set: vec![
                                "quickfix".to_string(),
                                "refactor".to_string(),
                                "refactor.extract".to_string(),
                                "refactor.inline".to_string(),
                                "refactor.rewrite".to_string(),
                                "source".to_string(),
                                "source.organizeImports".to_string(),
                            ],
                        },
                    }),
                    is_preferred_support: Some(true),
                    ..Default::default()
                }),
                definition: Some(lsp::GotoCapability {
                    dynamic_registration: Some(false),
                    ..Default::default()
                }),
                references: Some(lsp::ReferenceClientCapabilities {
                    dynamic_registration: Some(false),
                }),
                document_symbol: Some(lsp::DocumentSymbolClientCapabilities {
                    dynamic_registration: Some(false),
                    symbol_kind: Some(lsp::SymbolKindCapability {
                        value_set: Some(vec![
                            lsp::SymbolKind::FILE,
                            lsp::SymbolKind::MODULE,
                            lsp::SymbolKind::NAMESPACE,
                            lsp::SymbolKind::PACKAGE,
                            lsp::SymbolKind::CLASS,
                            lsp::SymbolKind::METHOD,
                            lsp::SymbolKind::PROPERTY,
                            lsp::SymbolKind::FIELD,
                            lsp::SymbolKind::CONSTRUCTOR,
                            lsp::SymbolKind::ENUM,
                            lsp::SymbolKind::INTERFACE,
                            lsp::SymbolKind::FUNCTION,
                            lsp::SymbolKind::VARIABLE,
                            lsp::SymbolKind::CONSTANT,
                            lsp::SymbolKind::STRING,
                            lsp::SymbolKind::NUMBER,
                            lsp::SymbolKind::BOOLEAN,
                            lsp::SymbolKind::ARRAY,
                            lsp::SymbolKind::OBJECT,
                            lsp::SymbolKind::KEY,
                            lsp::SymbolKind::NULL,
                            lsp::SymbolKind::ENUM_MEMBER,
                            lsp::SymbolKind::STRUCT,
                            lsp::SymbolKind::EVENT,
                            lsp::SymbolKind::OPERATOR,
                            lsp::SymbolKind::TYPE_PARAMETER,
                        ]),
                    }),
                    ..Default::default()
                }),
                formatting: Some(lsp::DocumentFormattingClientCapabilities {
                    dynamic_registration: Some(false),
                }),
                diagnostic: Some(lsp::DiagnosticClientCapabilities {
                    dynamic_registration: Some(false),
                    related_document_support: Some(false),
                }),
                ..Default::default()
            }),
            workspace: Some(lsp::WorkspaceClientCapabilities {
                ..Default::default()
            }),
            ..Default::default()
        };

        let init_params = lsp::InitializeParams {
            process_id: Some(std::process::id()),
            capabilities: caps,
            workspace_folders: Some(vec![lsp::WorkspaceFolder {
                uri: lsp::Url::from_directory_path(&workspace_root)
                    .map_err(|_| "caminho inválido".to_string())?,
                name: workspace_root
                    .split(['/', '\\'])
                    .last()
                    .unwrap_or("root")
                    .to_string(),
            }]),
            ..Default::default()
        };

        let result: lsp::InitializeResult = instance
            .request("initialize", init_params)
            .await
            .map_err(|e| format!("Falha na inicialização do LSP: {}", e))?;

        instance
            .notify("initialized", serde_json::json!({}))
            .await
            .map_err(|e| format!("Falha no initialized: {}", e))?;

        let instance = Arc::new(Mutex::new(instance));
        let mut instances = self.instances.write().await;
        instances.insert(language.clone(), instance);

        let name = result
            .server_info
            .as_ref()
            .map(|i| i.name.clone())
            .unwrap_or_else(|| cmd.to_string());

        Ok(format!("{} ({}) iniciado", name, language))
    }

    pub async fn stop(&self, language: &str) -> Result<(), String> {
        let mut instances = self.instances.write().await;
        if let Some(instance) = instances.remove(language) {
            let inst = instance.lock().await;
            let _ = inst.notify("shutdown", serde_json::json!({})).await;
            // Don't send exit - just drop
        }
        Ok(())
    }

    pub async fn did_open(
        &self,
        language: &str,
        file_path: &str,
        content: &str,
    ) -> Result<(), String> {
        let instance = self.get_instance(language).await?;
        let inst = instance.lock().await;
        let uri = lsp::Url::from_file_path(file_path)
            .map_err(|_| "caminho inválido".to_string())?;
        let lang_id = language_to_lsp_id(language);
        inst.notify(
            "textDocument/didOpen",
            lsp::DidOpenTextDocumentParams {
                text_document: lsp::TextDocumentItem {
                    uri,
                    language_id: lang_id.to_string(),
                    version: 1,
                    text: content.to_string(),
                },
            },
        )
        .await
    }

    pub async fn did_change(
        &self,
        language: &str,
        file_path: &str,
        content: &str,
        version: i32,
    ) -> Result<Vec<LspDiagnostic>, String> {
        let instance = self.get_instance(language).await?;
        let inst = instance.lock().await;
        let uri = lsp::Url::from_file_path(file_path)
            .map_err(|_| "caminho inválido".to_string())?;
        inst.notify(
            "textDocument/didChange",
            lsp::DidChangeTextDocumentParams {
                text_document: lsp::VersionedTextDocumentIdentifier {
                    uri: uri.clone(),
                    version,
                },
                content_changes: vec![lsp::TextDocumentContentChangeEvent {
                    range: None,
                    range_length: None,
                    text: content.to_string(),
                }],
            },
        )
        .await?;

        // Read pending diagnostics from server
        let mut diagnostics = Vec::new();
        // Small delay to let the server process the change
        tokio::time::sleep(Duration::from_millis(50)).await;
        // Read all available messages with a short timeout each
        for _ in 0..20 {
            match timeout(Duration::from_millis(50), inst.read_message()).await {
                Ok(Ok(msg)) => {
                    let is_diag = msg.method.as_deref() == Some("textDocument/publishDiagnostics");
                    if msg.id.is_none() && is_diag {
                        if let Some(params) = msg.params {
                            if let Ok(diag) =
                                serde_json::from_value::<lsp::PublishDiagnosticsParams>(params)
                            {
                                for d in diag.diagnostics {
                                    diagnostics.push(map_diagnostic(&diag.uri, d));
                                }
                            }
                        }
                    }
                }
                _ => break,
            }
        }
        Ok(diagnostics)
    }

    pub async fn did_close(&self, language: &str, file_path: &str) -> Result<(), String> {
        let instance = self.get_instance(language).await?;
        let inst = instance.lock().await;
        let uri = lsp::Url::from_file_path(file_path)
            .map_err(|_| "caminho inválido".to_string())?;
        inst.notify(
            "textDocument/didClose",
            lsp::DidCloseTextDocumentParams {
                text_document: lsp::TextDocumentIdentifier { uri },
            },
        )
        .await
    }

    pub async fn completion(
        &self,
        language: &str,
        file_path: &str,
        line: u32,
        col: u32,
    ) -> Result<Vec<LspCompletion>, String> {
        let instance = self.get_instance(language).await?;
        let inst = instance.lock().await;
        let uri = lsp::Url::from_file_path(file_path)
            .map_err(|_| "caminho inválido".to_string())?;
        let result: Option<lsp::CompletionResponse> = inst
            .request(
                "textDocument/completion",
                lsp::CompletionParams {
                    text_document_position: lsp::TextDocumentPositionParams {
                        text_document: lsp::TextDocumentIdentifier { uri },
                        position: lsp::Position {
                            line,
                            character: col,
                        },
                    },
                    work_done_progress_params: lsp::WorkDoneProgressParams::default(),
                    partial_result_params: lsp::PartialResultParams::default(),
                    context: None,
                },
            )
            .await
            .map_err(|e| format!("Falha no completion: {}", e))?;
        let items = match result {
            Some(lsp::CompletionResponse::Array(items)) => items,
            Some(lsp::CompletionResponse::List(list)) => list.items,
            None => vec![],
        };
        Ok(items
            .into_iter()
            .map(|item| LspCompletion {
                label: item.label,
                kind: item.kind.map(|k| format!("{:?}", k)),
                detail: item.detail,
                documentation: item.documentation.map(|d| match d {
                    lsp::Documentation::String(s) => s,
                    lsp::Documentation::MarkupContent(m) => m.value,
                }),
                insert_text: item.insert_text,
            })
            .collect())
    }

    pub async fn hover(
        &self,
        language: &str,
        file_path: &str,
        line: u32,
        col: u32,
    ) -> Result<Option<LspHover>, String> {
        let instance = self.get_instance(language).await?;
        let inst = instance.lock().await;
        let uri = lsp::Url::from_file_path(file_path)
            .map_err(|_| "caminho inválido".to_string())?;
        let result: Option<lsp::Hover> = inst
            .request(
                "textDocument/hover",
                lsp::HoverParams {
                    text_document_position_params: lsp::TextDocumentPositionParams {
                        text_document: lsp::TextDocumentIdentifier { uri },
                        position: lsp::Position {
                            line,
                            character: col,
                        },
                    },
                    work_done_progress_params: lsp::WorkDoneProgressParams::default(),
                },
            )
            .await
            .map_err(|e| format!("Falha no hover: {}", e))?;
        Ok(result.map(|h| {
            let contents = match h.contents {
                lsp::HoverContents::Scalar(s) => vec![match s {
                    lsp::MarkedString::String(s) => s,
                    lsp::MarkedString::LanguageString(ls) => {
                        format!("```{}\n{}```", ls.language, ls.value)
                    }
                }],
                lsp::HoverContents::Array(arr) => arr
                    .into_iter()
                    .map(|s| match s {
                        lsp::MarkedString::String(s) => s,
                        lsp::MarkedString::LanguageString(ls) => {
                            format!("```{}\n{}```", ls.language, ls.value)
                        }
                    })
                    .collect(),
                lsp::HoverContents::Markup(m) => vec![m.value],
            };
            let range = h
                .range
                .map(|r| [r.start.line, r.start.character, r.end.line, r.end.character]);
            LspHover { contents, range }
        }))
    }

    pub async fn signature_help(
        &self,
        language: &str,
        file_path: &str,
        line: u32,
        col: u32,
    ) -> Result<Option<LspSignatureHelp>, String> {
        let instance = self.get_instance(language).await?;
        let inst = instance.lock().await;
        let uri = lsp::Url::from_file_path(file_path)
            .map_err(|_| "caminho inválido".to_string())?;
        let result: Option<lsp::SignatureHelp> = inst
            .request(
                "textDocument/signatureHelp",
                lsp::SignatureHelpParams {
                    text_document_position_params: lsp::TextDocumentPositionParams {
                        text_document: lsp::TextDocumentIdentifier { uri },
                        position: lsp::Position {
                            line,
                            character: col,
                        },
                    },
                    work_done_progress_params: lsp::WorkDoneProgressParams::default(),
                    context: None,
                },
            )
            .await
            .map_err(|e| format!("Falha no signatureHelp: {}", e))?;
        Ok(result.map(|sh| LspSignatureHelp {
            active_signature: sh.active_signature.unwrap_or(0) as i32,
            active_parameter: sh.active_parameter.unwrap_or(0) as i32,
            signatures: sh
                .signatures
                .into_iter()
                .map(|s| {
                    let sig_label = s.label.clone();
                    LspSignatureInfo {
                        label: s.label,
                        documentation: s.documentation.map(|d| match d {
                            lsp::Documentation::String(s) => s,
                            lsp::Documentation::MarkupContent(m) => m.value,
                        }),
                        parameters: s
                            .parameters
                            .unwrap_or_default()
                            .into_iter()
                            .map(|p| {
                                let label = match p.label {
                                    lsp::ParameterLabel::Simple(l) => l,
                                    lsp::ParameterLabel::LabelOffsets(offsets) => {
                                        sig_label[offsets[0] as usize..offsets[1] as usize].to_string()
                                    }
                                };
                                LspParameterInfo {
                                    label,
                                    documentation: p.documentation.map(|d| match d {
                                        lsp::Documentation::String(s) => s,
                                        lsp::Documentation::MarkupContent(m) => m.value,
                                    }),
                                }
                            })
                            .collect(),
                    }
                })
                .collect(),
        }))
    }

    pub async fn code_action(
        &self,
        language: &str,
        file_path: &str,
        line: u32,
        col: u32,
    ) -> Result<Vec<LspCodeAction>, String> {
        let instance = self.get_instance(language).await?;
        let inst = instance.lock().await;
        let uri = lsp::Url::from_file_path(file_path)
            .map_err(|_| "caminho inválido".to_string())?;
        let result: Option<Vec<lsp::CodeActionOrCommand>> = inst
            .request(
                "textDocument/codeAction",
                lsp::CodeActionParams {
                    text_document: lsp::TextDocumentIdentifier { uri },
                    range: lsp::Range {
                        start: lsp::Position { line, character: col },
                        end: lsp::Position {
                            line,
                            character: col + 1,
                        },
                    },
                    context: lsp::CodeActionContext {
                        diagnostics: vec![],
                        only: None,
                        ..Default::default()
                    },
                    work_done_progress_params: lsp::WorkDoneProgressParams::default(),
                    partial_result_params: lsp::PartialResultParams::default(),
                },
            )
            .await
            .map_err(|e| format!("Falha no codeAction: {}", e))?;
        Ok(result
            .unwrap_or_default()
            .into_iter()
            .filter_map(|action| match action {
                lsp::CodeActionOrCommand::CodeAction(ca) => Some(LspCodeAction {
                    title: ca.title,
                    kind: ca.kind.map(|k| k.as_str().to_string()),
                    diagnostics: vec![],
                    is_preferred: ca.is_preferred.unwrap_or(false),
                }),
                lsp::CodeActionOrCommand::Command(_) => None,
            })
            .collect())
    }

    pub async fn go_to_definition(
        &self,
        language: &str,
        file_path: &str,
        line: u32,
        col: u32,
    ) -> Result<Option<LspLocation>, String> {
        let instance = self.get_instance(language).await?;
        let inst = instance.lock().await;
        let uri = lsp::Url::from_file_path(file_path)
            .map_err(|_| "caminho inválido".to_string())?;
        let result: Option<lsp::GotoDefinitionResponse> = inst
            .request(
                "textDocument/definition",
                lsp::GotoDefinitionParams {
                    text_document_position_params: lsp::TextDocumentPositionParams {
                        text_document: lsp::TextDocumentIdentifier { uri },
                        position: lsp::Position {
                            line,
                            character: col,
                        },
                    },
                    work_done_progress_params: lsp::WorkDoneProgressParams::default(),
                    partial_result_params: lsp::PartialResultParams::default(),
                },
            )
            .await
            .map_err(|e| format!("Falha no definition: {}", e))?;
        match result {
            Some(lsp::GotoDefinitionResponse::Scalar(loc)) => Ok(Some(LspLocation {
                uri: loc.uri.to_string(),
                range: [
                    loc.range.start.line,
                    loc.range.start.character,
                    loc.range.end.line,
                    loc.range.end.character,
                ],
            })),
            Some(lsp::GotoDefinitionResponse::Array(locs)) => locs.into_iter().next().map_or(
                Ok(None),
                |loc| {
                    Ok(Some(LspLocation {
                        uri: loc.uri.to_string(),
                        range: [
                            loc.range.start.line,
                            loc.range.start.character,
                            loc.range.end.line,
                            loc.range.end.character,
                        ],
                    }))
                },
            ),
            Some(lsp::GotoDefinitionResponse::Link(links)) => links.into_iter().next().map_or(
                Ok(None),
                |link| {
                    Ok(Some(LspLocation {
                        uri: link.target_uri.to_string(),
                        range: [
                            link.target_range.start.line,
                            link.target_range.start.character,
                            link.target_range.end.line,
                            link.target_range.end.character,
                        ],
                    }))
                },
            ),
            None => Ok(None),
        }
    }

    pub async fn find_references(
        &self,
        language: &str,
        file_path: &str,
        line: u32,
        col: u32,
    ) -> Result<Vec<LspLocation>, String> {
        let instance = self.get_instance(language).await?;
        let inst = instance.lock().await;
        let uri = lsp::Url::from_file_path(file_path)
            .map_err(|_| "caminho inválido".to_string())?;
        let result: Option<Vec<lsp::Location>> = inst
            .request(
                "textDocument/references",
                lsp::ReferenceParams {
                    text_document_position: lsp::TextDocumentPositionParams {
                        text_document: lsp::TextDocumentIdentifier { uri },
                        position: lsp::Position {
                            line,
                            character: col,
                        },
                    },
                    work_done_progress_params: lsp::WorkDoneProgressParams::default(),
                    partial_result_params: lsp::PartialResultParams::default(),
                    context: lsp::ReferenceContext {
                        include_declaration: true,
                    },
                },
            )
            .await
            .map_err(|e| format!("Falha no references: {}", e))?;
        Ok(result
            .unwrap_or_default()
            .into_iter()
            .map(|loc| LspLocation {
                uri: loc.uri.to_string(),
                range: [
                    loc.range.start.line,
                    loc.range.start.character,
                    loc.range.end.line,
                    loc.range.end.character,
                ],
            })
            .collect())
    }

    pub async fn document_symbols(
        &self,
        language: &str,
        file_path: &str,
    ) -> Result<Vec<LspSymbol>, String> {
        let instance = self.get_instance(language).await?;
        let inst = instance.lock().await;
        let uri = lsp::Url::from_file_path(file_path)
            .map_err(|_| "caminho inválido".to_string())?;
        let result: Option<lsp::DocumentSymbolResponse> = inst
            .request(
                "textDocument/documentSymbol",
                lsp::DocumentSymbolParams {
                    text_document: lsp::TextDocumentIdentifier { uri },
                    work_done_progress_params: lsp::WorkDoneProgressParams::default(),
                    partial_result_params: lsp::PartialResultParams::default(),
                },
            )
            .await
            .map_err(|e| format!("Falha no documentSymbol: {}", e))?;
        match result {
            Some(lsp::DocumentSymbolResponse::Nested(symbols)) => {
                Ok(symbols.into_iter().map(|s| map_symbol(s)).collect())
            }
            Some(lsp::DocumentSymbolResponse::Flat(symbols)) => Ok(symbols
                .into_iter()
                .map(|s| LspSymbol {
                    name: s.name,
                    kind: format!("{:?}", s.kind),
                    detail: None,
                    range: [
                        s.location.range.start.line,
                        s.location.range.start.character,
                        s.location.range.end.line,
                        s.location.range.end.character,
                    ],
                    selection_range: [
                        s.location.range.start.line,
                        s.location.range.start.character,
                        s.location.range.end.line,
                        s.location.range.end.character,
                    ],
                    children: vec![],
                })
                .collect()),
            None => Ok(vec![]),
        }
    }

    pub async fn format_document(
        &self,
        language: &str,
        file_path: &str,
    ) -> Result<Vec<LspTextEdit>, String> {
        let instance = self.get_instance(language).await?;
        let inst = instance.lock().await;
        let uri = lsp::Url::from_file_path(file_path)
            .map_err(|_| "caminho inválido".to_string())?;
        let result: Option<Vec<lsp::TextEdit>> = inst
            .request(
                "textDocument/formatting",
                lsp::DocumentFormattingParams {
                    text_document: lsp::TextDocumentIdentifier { uri },
                    options: lsp::FormattingOptions {
                        tab_size: 4,
                        insert_spaces: true,
                        ..Default::default()
                    },
                    work_done_progress_params: lsp::WorkDoneProgressParams::default(),
                },
            )
            .await
            .map_err(|e| format!("Falha no formatting: {}", e))?;
        Ok(result
            .unwrap_or_default()
            .into_iter()
            .map(|edit| LspTextEdit {
                range: [
                    edit.range.start.line,
                    edit.range.start.character,
                    edit.range.end.line,
                    edit.range.end.character,
                ],
                new_text: edit.new_text,
            })
            .collect())
    }

    #[allow(dead_code)]
    pub async fn status(&self, language: &str) -> Result<LspStatus, String> {
        let instance = self.get_instance(language).await?;
        let inst = instance.lock().await;
        Ok(LspStatus {
            running: true,
            language: language.to_string(),
            server_name: inst.server_name.clone(),
        })
    }
}

// ---------------------------------------------------------------------------
// Resource resolution for bundled / offline LSP servers
// ---------------------------------------------------------------------------

/// Returns a (cmd, args) pair for the given language.
/// Checks bundled resources first, then falls back to PATH.
pub fn resolve_command(language: &str, resource_dir: &std::path::Path) -> Result<(String, Vec<String>), String> {
    let (base_cmd, base_args) = LspManager::server_command(language)
        .ok_or_else(|| format!("Nenhum LSP configurado para '{}'", language))?;

    let args: Vec<String> = base_args.iter().map(|a| a.to_string()).collect();

    // Try bundled resource first — returns Some((exe, extra_args))
    if let Some((exe, extra)) = find_bundled_lsp(resource_dir, base_cmd) {
        let mut all_args = extra;
        all_args.extend(args);
        return Ok((exe, all_args));
    }

    // Fallback: use PATH
    Ok((base_cmd.to_string(), args))
}

/// Returns (exe, extra_args_to_prepend) for a bundled LSP, or None if not found.
fn find_bundled_lsp(resource_dir: &std::path::Path, server_name: &str) -> Option<(String, Vec<String>)> {
    match server_name {
        "rust-analyzer" => {
            let p = resource_dir.join("lsp-packages/bin/rust-analyzer.exe");
            if p.exists() {
                Some((p.to_string_lossy().to_string(), vec![]))
            } else {
                None
            }
        }
        "gopls" => {
            let p = resource_dir.join("lsp-packages/bin/gopls.exe");
            if p.exists() {
                Some((p.to_string_lossy().to_string(), vec![]))
            } else {
                None
            }
        }
        "pylsp" => {
            let py = resource_dir.join("lsp-packages/python/python.exe");
            if py.exists() {
                Some((py.to_string_lossy().to_string(), vec!["-m".into(), "pylsp".into()]))
            } else {
                None
            }
        }
        // npm-based LSPs: invoke via cmd /c on Windows
        "typescript-language-server"
        | "yaml-language-server"
        | "vscode-html-language-server"
        | "vscode-css-language-server"
        | "vscode-json-language-server" => {
            let rel = format!("lsp-packages/node_modules/.bin/{}.cmd", server_name);
            let p = resource_dir.join(&rel);
            if p.exists() {
                Some(("cmd".into(), vec!["/c".into(), p.to_string_lossy().to_string()]))
            } else {
                None
            }
        }
        "dart" => {
            let p = resource_dir.join("lsp-packages/dart-sdk/bin/dart.exe");
            if p.exists() {
                Some((p.to_string_lossy().to_string(), vec!["language-server".into(), "--protocol=stdio".into()]))
            } else {
                None
            }
        }
        _ => None, // no bundled resource (fallback to PATH)
    }
}

/// Check whether a bundled LSP resource exists (for offline status).
pub fn check_bundled_lsp(resource_dir: &std::path::Path, server_name: &str) -> bool {
    find_bundled_lsp(resource_dir, server_name).is_some()
}

// ---------------------------------------------------------------------------
// LspInstance implementation
// ---------------------------------------------------------------------------

struct LspInstance {
    stdin: Mutex<ChildStdin>,
    reader: Mutex<BufReader<ChildStdout>>,
    next_id: AtomicU64,
    server_name: String,
}

impl LspInstance {
    async fn read_message_raw(&self) -> Result<String, String> {
        let mut reader = self.reader.lock().await;
        let mut content_length: usize = 0;
        loop {
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .await
                .map_err(|e| format!("Erro lendo header: {}", e))?;
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
            .map_err(|e| format!("Erro lendo body: {}", e))?;
        String::from_utf8(buf).map_err(|e| format!("Erro UTF-8: {}", e))
    }

    async fn read_message(&self) -> Result<JsonRpcResponse, String> {
        let raw = self.read_message_raw().await?;
        serde_json::from_str(&raw).map_err(|e| format!("Erro parseando JSON-RPC: {}", e))
    }

    async fn send_message(&self, body: &str) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        stdin
            .write_all(header.as_bytes())
            .await
            .map_err(|e| format!("Erro escrevendo header: {}", e))?;
        stdin
            .write_all(body.as_bytes())
            .await
            .map_err(|e| format!("Erro escrevendo body: {}", e))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("Erro no flush: {}", e))?;
        Ok(())
    }

    async fn request<T: serde::Serialize, R: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        params: T,
    ) -> Result<R, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let body = serde_json::to_string(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": serde_json::to_value(params).map_err(|e| e.to_string())?,
        }))
        .map_err(|e| e.to_string())?;

        self.send_message(&body).await?;

        loop {
            let response = self.read_message().await?;
            if response.id == Some(id) {
                if let Some(err) = response.error {
                    return Err(format!("Erro LSP ({}): {}", err.code, err.message));
                }
                let result: R = serde_json::from_value(
                    response.result.unwrap_or(serde_json::Value::Null),
                )
                .map_err(|e| format!("Erro parseando resultado: {}", e))?;
                return Ok(result);
            }
            // Ignore other messages (notifications, diagnostics, etc.)
        }
    }

    async fn notify<T: serde::Serialize>(&self, method: &str, params: T) -> Result<(), String> {
        let body = serde_json::to_string(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": serde_json::to_value(params).map_err(|e| e.to_string())?,
        }))
        .map_err(|e| e.to_string())?;
        self.send_message(&body).await
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn language_to_lsp_id(language: &str) -> &str {
    match language {
        "rs" | "rust" => "rust",
        "py" | "python" => "python",
        "ts" | "typescript" => "typescript",
        "tsx" => "typescriptreact",
        "js" | "javascript" => "javascript",
        "jsx" => "javascriptreact",
        "go" => "go",
        "html" => "html",
        "css" => "css",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        _ => language,
    }
}

fn map_diagnostic(uri: &lsp::Url, d: lsp::Diagnostic) -> LspDiagnostic {
    LspDiagnostic {
        file_path: uri.to_string(),
        range: [
            d.range.start.line,
            d.range.start.character,
            d.range.end.line,
            d.range.end.character,
        ],
        severity: match d.severity {
            Some(lsp::DiagnosticSeverity::ERROR) => "error".into(),
            Some(lsp::DiagnosticSeverity::WARNING) => "warning".into(),
            Some(lsp::DiagnosticSeverity::INFORMATION) => "info".into(),
            Some(lsp::DiagnosticSeverity::HINT) => "hint".into(),
            _ => "info".into(),
        },
        message: d.message,
        source: d.source,
        code: d.code.map(|c| match c {
            lsp::NumberOrString::Number(n) => n.to_string(),
            lsp::NumberOrString::String(s) => s,
        }),
    }
}

fn map_symbol(s: lsp::DocumentSymbol) -> LspSymbol {
    LspSymbol {
        name: s.name,
        kind: format!("{:?}", s.kind),
        detail: s.detail,
        range: [
            s.range.start.line,
            s.range.start.character,
            s.range.end.line,
            s.range.end.character,
        ],
        selection_range: [
            s.selection_range.start.line,
            s.selection_range.start.character,
            s.selection_range.end.line,
            s.selection_range.end.character,
        ],
        children: s.children.unwrap_or_default().into_iter().map(map_symbol).collect(),
    }
}

