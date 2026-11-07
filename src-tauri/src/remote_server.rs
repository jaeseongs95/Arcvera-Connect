//! Headless HTTP + SSE remote server for OpenDIY Remote (`--remote`).
//! Exposes the same `session::Engine` commands over `/api/invoke` and `/api/events`
//! while serving the built OpenDIY Desktop frontend (`dist/`) to web browsers.

use crate::{
    codex, conversation_attachments::ConversationAttachment, process_job,
    session::{BackendEvent, Engine, StartRequest},
    ui_language::UiLanguage,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};

const MAX_HTTP_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_SSE_CLIENT_QUEUE: usize = 256;
const MAX_CONCURRENT_HTTP_CLIENTS: usize = 64;
const REMOTE_SCRIPT_TAG: &str = "<script>window.__OPENDIY_REMOTE__=true;</script>";

struct ActiveClientGuard(Arc<AtomicUsize>);

impl Drop for ActiveClientGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Clone, Default)]
pub struct EventHub {
    clients: Arc<Mutex<Vec<mpsc::SyncSender<String>>>>,
}

impl EventHub {
    pub fn subscribe(&self) -> mpsc::Receiver<String> {
        let (tx, rx) = mpsc::sync_channel(MAX_SSE_CLIENT_QUEUE);
        if let Ok(mut clients) = self.clients.lock() {
            clients.push(tx);
        }
        rx
    }

    pub fn broadcast(&self, event: &str, payload: Value) {
        let frame = serde_json::to_string(&json!({ "event": event, "payload": payload }))
            .unwrap_or_else(|_| "{}".to_owned());
        if let Ok(mut clients) = self.clients.lock() {
            // Bounded non-blocking send: slow or disconnected SSE clients are evicted
            // immediately so PTY output bursts cannot accumulate unbounded memory.
            clients.retain(|tx| tx.try_send(frame.clone()).is_ok());
        }
    }
}

pub fn inject_remote_flag(html: &str) -> String {
    if html.contains("__OPENDIY_REMOTE__") {
        return html.to_owned();
    }
    if let Some(index) = html.find("<head>") {
        let insert_at = index + "<head>".len();
        let mut out = String::with_capacity(html.len() + REMOTE_SCRIPT_TAG.len());
        out.push_str(&html[..insert_at]);
        out.push_str(REMOTE_SCRIPT_TAG);
        out.push_str(&html[insert_at..]);
        return out;
    }
    format!("{REMOTE_SCRIPT_TAG}{html}")
}

pub fn verify_token(expected_sha256: Option<&[u8; 32]>, provided: Option<&str>) -> bool {
    let Some(expected) = expected_sha256 else {
        return true;
    };
    let Some(token) = provided.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    let digest: [u8; 32] = Sha256::digest(token.as_bytes()).into();
    let mut diff = 0u8;
    for (a, b) in expected.iter().zip(digest.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn arg_val<'a>(args: &'a Value, camel: &str, snake: &str) -> &'a Value {
    args.get(camel).or_else(|| args.get(snake)).unwrap_or(&Value::Null)
}

fn req_field<T: DeserializeOwned>(args: &Value, camel: &str, snake: &str) -> Result<T, String> {
    let raw = arg_val(args, camel, snake);
    serde_json::from_value(raw.clone())
        .map_err(|e| format!("invalid argument '{camel}': {e}"))
}

fn opt_field<T: DeserializeOwned>(args: &Value, camel: &str, snake: &str) -> Result<Option<T>, String> {
    let raw = arg_val(args, camel, snake);
    if raw.is_null() {
        return Ok(None);
    }
    serde_json::from_value(raw.clone())
        .map(Some)
        .map_err(|e| format!("invalid optional argument '{camel}': {e}"))
}

pub fn dispatch_command(engine: &Engine, command: &str, args: &Value) -> Result<Value, String> {
    match command {
        "get_ui_language" => serde_json::to_value(engine.get_ui_language()?).map_err(|e| e.to_string()),
        "set_ui_language" => {
            let language: UiLanguage = req_field(args, "language", "language")?;
            engine.set_ui_language(language)?;
            Ok(json!({
                "show": language.text("OpenDIY Desktop 열기", "Open OpenDIY Desktop"),
                "exit": language.text("종료…", "Exit…"),
            }))
        }
        "prepare_runtime" => {
            engine.prepare_runtime()?;
            Ok(Value::Null)
        }
        "start_session" => {
            let request: StartRequest = req_field(args, "request", "request")?;
            serde_json::to_value(engine.start(request)?).map_err(|e| e.to_string())
        }
        "list_sessions" => serde_json::to_value(engine.list()?).map_err(|e| e.to_string()),
        "session_write" => {
            let id: String = req_field(args, "id", "id")?;
            let generation: u64 = req_field(args, "generation", "generation")?;
            let data: String = req_field(args, "data", "data")?;
            engine.write(&id, generation, &data)?;
            Ok(Value::Null)
        }
        "session_resize" => {
            let id: String = req_field(args, "id", "id")?;
            let generation: u64 = req_field(args, "generation", "generation")?;
            let cols: u16 = req_field(args, "cols", "cols")?;
            let rows: u16 = req_field(args, "rows", "rows")?;
            engine.resize(&id, generation, cols, rows)?;
            Ok(Value::Null)
        }
        "session_stop" => {
            let id: String = req_field(args, "id", "id")?;
            let generation: u64 = req_field(args, "generation", "generation")?;
            engine.stop(&id, generation)?;
            Ok(Value::Null)
        }
        "session_output_ack" => {
            let id: String = req_field(args, "id", "id")?;
            let generation: u64 = req_field(args, "generation", "generation")?;
            let seq: u64 = req_field(args, "seq", "seq")?;
            engine.acknowledge(&id, generation, seq)?;
            Ok(Value::Null)
        }
        "load_layout" => engine.load_layout(),
        "save_layout" => {
            let layout = arg_val(args, "layout", "layout");
            engine.save_layout(layout)?;
            Ok(Value::Null)
        }
        "list_external" => serde_json::to_value(engine.list_external()?).map_err(|e| e.to_string()),
        "get_codex_settings" => serde_json::to_value(engine.get_codex_settings()?).map_err(|e| e.to_string()),
        "runtime_compatibility" => serde_json::to_value(engine.runtime_compatibility()?).map_err(|e| e.to_string()),
        "runtime_pair_status" => serde_json::to_value(engine.runtime_pair_status()?).map_err(|e| e.to_string()),
        "runtime_transition_preview" => serde_json::to_value(engine.runtime_transition_preview()?).map_err(|e| e.to_string()),
        "apply_runtime_transition" => {
            let confirmed: bool = req_field(args, "confirmed", "confirmed")?;
            let fingerprint: String = req_field(args, "fingerprint", "fingerprint")?;
            serde_json::to_value(engine.apply_runtime_transition(confirmed, &fingerprint)?).map_err(|e| e.to_string())
        }
        "set_codex_executable" => {
            let path: Option<String> = opt_field(args, "path", "path")?;
            serde_json::to_value(engine.set_codex_executable(path.as_deref())?).map_err(|e| e.to_string())
        }
        "set_app_server_executable" => {
            let path: Option<String> = opt_field(args, "path", "path")?;
            serde_json::to_value(engine.set_app_server_executable(path.as_deref())?).map_err(|e| e.to_string())
        }
        "list_projects" => serde_json::to_value(engine.list_projects()?).map_err(|e| e.to_string()),
        "import_project" => {
            let cwd: String = req_field(args, "cwd", "cwd")?;
            serde_json::to_value(engine.import_project(&cwd)?).map_err(|e| e.to_string())
        }
        "create_project" => {
            let name: String = req_field(args, "name", "name")?;
            let cwd: Option<String> = opt_field(args, "cwd", "cwd")?;
            serde_json::to_value(engine.create_project(&name, cwd.as_deref())?).map_err(|e| e.to_string())
        }
        "rename_project" => {
            let id: String = req_field(args, "id", "id")?;
            let name: String = req_field(args, "name", "name")?;
            serde_json::to_value(engine.rename_project(&id, &name)?).map_err(|e| e.to_string())
        }
        "set_project_favorite" => {
            let id: String = req_field(args, "id", "id")?;
            let favorite: bool = req_field(args, "favorite", "favorite")?;
            serde_json::to_value(engine.set_project_favorite(&id, favorite)?).map_err(|e| e.to_string())
        }
        "delete_project" => {
            let id: String = req_field(args, "id", "id")?;
            engine.delete_project(&id)?;
            Ok(Value::Null)
        }
        "reorder_project" => {
            let id: String = req_field(args, "id", "id")?;
            let target_id: String = req_field(args, "targetId", "target_id")?;
            let after: bool = req_field(args, "after", "after")?;
            serde_json::to_value(engine.reorder_project(&id, &target_id, after)?).map_err(|e| e.to_string())
        }
        "move_session_to_project" => {
            let id: String = req_field(args, "id", "id")?;
            let generation: u64 = req_field(args, "generation", "generation")?;
            let project_id: Option<String> = opt_field(args, "projectId", "project_id")?;
            serde_json::to_value(engine.move_session_to_project(&id, generation, project_id.as_deref())?).map_err(|e| e.to_string())
        }
        "catalog_list" => {
            let request: codex::CatalogQuery = req_field(args, "request", "request")?;
            serde_json::to_value(engine.catalog_list(request)?).map_err(|e| e.to_string())
        }
        "catalog_preview" => {
            let thread_id: String = req_field(args, "threadId", "thread_id")?;
            let cursor: Option<String> = opt_field(args, "cursor", "cursor")?;
            serde_json::to_value(engine.catalog_preview(&thread_id, cursor)?).map_err(|e| e.to_string())
        }
        "extensions_list" => {
            let cwd: Option<String> = opt_field(args, "cwd", "cwd")?;
            let catalog_query: Option<String> = opt_field(args, "catalogQuery", "catalog_query")?;
            let snapshot = match catalog_query {
                Some(query) => engine.extensions_list_with_catalog_query(cwd, Some(query))?,
                None => engine.extensions_list(cwd)?,
            };
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        "extensions_mutate" => {
            let cwd: Option<String> = opt_field(args, "cwd", "cwd")?;
            let request: codex::ExtensionMutation = req_field(args, "request", "request")?;
            serde_json::to_value(engine.extensions_mutate(cwd, request)?).map_err(|e| e.to_string())
        }
        "mobile_control" => {
            let id: String = req_field(args, "id", "id")?;
            let generation: u64 = req_field(args, "generation", "generation")?;
            let action: codex::MobileAction = req_field(args, "action", "action")?;
            serde_json::to_value(engine.mobile_control(&id, generation, action)?).map_err(|e| e.to_string())
        }
        "subagents_request" => {
            let id: String = req_field(args, "id", "id")?;
            let generation: u64 = req_field(args, "generation", "generation")?;
            let request: codex::SubagentRequest = req_field(args, "request", "request")?;
            engine.subagents_request(&id, generation, request)
        }
        "cron_request" => {
            let id: String = req_field(args, "id", "id")?;
            let generation: u64 = req_field(args, "generation", "generation")?;
            let request: codex::CronRequest = req_field(args, "request", "request")?;
            engine.cron_request(&id, generation, request)
        }
        "saved_cron_list" => {
            let thread_id: String = req_field(args, "threadId", "thread_id")?;
            serde_json::to_value(engine.saved_cron_list(&thread_id)?).map_err(|e| e.to_string())
        }
        "saved_cron_save" => {
            let id: Option<String> = opt_field(args, "id", "id")?;
            let thread_id: String = req_field(args, "threadId", "thread_id")?;
            let prompt: String = req_field(args, "prompt", "prompt")?;
            let schedule: codex::CronSchedule = req_field(args, "schedule", "schedule")?;
            serde_json::to_value(engine.saved_cron_save(id, thread_id, prompt, schedule)?).map_err(|e| e.to_string())
        }
        "saved_cron_delete" => {
            let id: String = req_field(args, "id", "id")?;
            let thread_id: String = req_field(args, "threadId", "thread_id")?;
            engine.saved_cron_delete(&id, &thread_id)?;
            Ok(Value::Null)
        }
        "saved_cron_register" => {
            let id: String = req_field(args, "id", "id")?;
            let generation: u64 = req_field(args, "generation", "generation")?;
            let definition_id: String = req_field(args, "definitionId", "definition_id")?;
            let thread_id: String = req_field(args, "threadId", "thread_id")?;
            engine.saved_cron_register(&id, generation, &definition_id, &thread_id)
        }
        "conversation_request" => {
            let id: String = req_field(args, "id", "id")?;
            let generation: u64 = req_field(args, "generation", "generation")?;
            let request: codex::ConversationRequest = req_field(args, "request", "request")?;
            engine.conversation_request(&id, generation, request)
        }
        "list_pending_questions" => engine.list_pending_questions(),
        "respond_pending_question" => {
            let session_id: String = req_field(args, "sessionId", "session_id")?;
            let generation: u64 = req_field(args, "generation", "generation")?;
            let request_id: String = req_field(args, "requestId", "request_id")?;
            let answers: Option<Value> = opt_field(args, "answers", "answers")?;
            let decision: Option<String> = opt_field(args, "decision", "decision")?;
            let result = match (answers, decision) {
                (Some(answers), None) => json!({ "answers": answers }),
                (None, Some(decision)) => json!({ "decision": decision }),
                _ => return Err("질문 답변 또는 승인 결정 중 하나만 지정하세요.".into()),
            };
            engine.conversation_request(
                &session_id,
                generation,
                codex::ConversationRequest::Respond { request_id, result },
            )
        }
        "choose_conversation_attachments" => {
            let paths: Vec<String> = opt_field(args, "paths", "paths")?.unwrap_or_default();
            let mut items = Vec::new();
            for raw in paths.into_iter().take(12) {
                let candidate = PathBuf::from(&raw);
                if !candidate.is_absolute() {
                    return Err("첨부 파일은 절대 경로여야 합니다.".into());
                }
                let meta = fs::symlink_metadata(&candidate)
                    .map_err(|e| format!("첨부 파일 확인 실패: {e}"))?;
                if !meta.is_file() {
                    return Err("첨부 대상이 일반 파일이 아닙니다.".into());
                }
                let name = candidate
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("attachment")
                    .to_owned();
                let ext = candidate
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let kind = if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
                    "localImage"
                } else {
                    "file"
                };
                items.push(ConversationAttachment {
                    kind,
                    path: raw,
                    name,
                });
            }
            serde_json::to_value(items).map_err(|e| e.to_string())
        }
        "conversation_attachment_storage" => {
            serde_json::to_value(engine.conversation_attachments().storage_usage()?).map_err(|e| e.to_string())
        }
        "stage_conversation_image" => {
            let id: String = req_field(args, "id", "id")?;
            let generation: u64 = req_field(args, "generation", "generation")?;
            let data_url: String = req_field(args, "dataUrl", "data_url")?;
            serde_json::to_value(engine.stage_conversation_image(&id, generation, &data_url)?).map_err(|e| e.to_string())
        }
        "cleanup_conversation_attachment" => {
            let id: String = req_field(args, "id", "id")?;
            let generation: u64 = req_field(args, "generation", "generation")?;
            let path: String = req_field(args, "path", "path")?;
            engine.cleanup_conversation_attachment(&id, generation, &path)?;
            Ok(Value::Null)
        }
        "weekly_usage" => {
            let manual: Option<bool> = opt_field(args, "manual", "manual")?;
            serde_json::to_value(engine.weekly_usage(manual.unwrap_or(false))?).map_err(|e| e.to_string())
        }
        "unconfirmed_exit_available" => serde_json::to_value(engine.unconfirmed_exit_available()?).map_err(|e| e.to_string()),
        "open_external_url" => {
            let url: String = req_field(args, "url", "url")?;
            let trimmed = url.trim();
            if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
                return Err("외부 링크는 http:// 또는 https:// 주소만 허용됩니다.".into());
            }
            Ok(Value::Null)
        }
        "choose_project_folder" | "choose_skill_folder" => {
            let path: Option<String> = opt_field(args, "path", "cwd")?;
            match path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(raw) => {
                    let dir = crate::project::directory(raw)?;
                    Ok(json!(dir.to_string_lossy()))
                }
                None => Ok(Value::Null),
            }
        }
        "choose_project" => {
            let cwd: Option<String> = opt_field(args, "cwd", "path")?;
            match cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(raw) => serde_json::to_value(engine.import_project(raw)?).map_err(|e| e.to_string()),
                None => Ok(Value::Null),
            }
        }
        "choose_codex_executable" => {
            let path: Option<String> = opt_field(args, "path", "path")?;
            match path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(raw) => serde_json::to_value(engine.set_codex_executable(Some(raw))?).map_err(|e| e.to_string()),
                None => Ok(Value::Null),
            }
        }
        "choose_app_server_executable" => {
            let path: Option<String> = opt_field(args, "path", "path")?;
            match path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(raw) => serde_json::to_value(engine.set_app_server_executable(Some(raw))?).map_err(|e| e.to_string()),
                None => Ok(Value::Null),
            }
        }
        "complete_exit" => {
            let confirmed: bool = req_field(args, "confirmed", "confirmed")?;
            let allow_unconfirmed: Option<bool> =
                opt_field(args, "allowUnconfirmedRemote", "allow_unconfirmed_remote")?;
            if !confirmed {
                return Err("explicit exit confirmation is required".into());
            }
            if allow_unconfirmed == Some(true) {
                engine.shutdown_with_unconfirmed_remote()?;
            } else {
                engine.shutdown()?;
            }
            Ok(Value::Null)
        }
        _ => Err(format!("지원하지 않는 원격 명령입니다: {command}")),
    }
}

fn content_type_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn resolve_static_path(dist_dir: &Path, request_path: &str) -> Option<PathBuf> {
    let trimmed = request_path.split('?').next().unwrap_or("/").trim_start_matches('/');
    let relative = if trimmed.is_empty() { "index.html" } else { trimmed };
    let candidate = Path::new(relative);
    if candidate.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    let full = dist_dir.join(candidate);
    if full.is_file() {
        Some(full)
    } else {
        let index = dist_dir.join("index.html");
        index.is_file().then_some(index)
    }
}

fn write_http_response(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8]) {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn write_json_response(stream: &mut TcpStream, status: &str, value: &Value) {
    let bytes = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    write_http_response(stream, status, "application/json; charset=utf-8", &bytes);
}

fn extract_query_param(target: &str, key: &str) -> Option<String> {
    let query = target.split_once('?')?.1;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k == key {
            return Some(v.to_owned());
        }
    }
    None
}

fn handle_client(
    mut stream: TcpStream,
    engine: Arc<Engine>,
    hub: EventHub,
    dist_dir: Arc<PathBuf>,
    token_sha256: Option<[u8; 32]>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(cloned) => cloned,
        Err(_) => return,
    });

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).ok().filter(|&n| n > 0).is_none() {
        return;
    }
    let parts: Vec<&str> = request_line.trim_end().split_whitespace().collect();
    if parts.len() < 2 {
        return;
    }
    let method = parts[0];
    let target = parts[1];

    let mut content_length = 0usize;
    let mut bearer_token: Option<String> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok().filter(|&n| n > 0).is_none() {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, val)) = trimmed.split_once(':') {
            let name_lower = name.trim().to_ascii_lowercase();
            let val_trimmed = val.trim();
            if name_lower == "content-length" {
                content_length = val_trimmed.parse::<usize>().unwrap_or(0);
            } else if name_lower == "authorization" {
                if let Some(tok) = val_trimmed.strip_prefix("Bearer ") {
                    bearer_token = Some(tok.trim().to_owned());
                }
            }
        }
    }

    if content_length > MAX_HTTP_BODY_BYTES {
        write_json_response(
            &mut stream,
            "413 Payload Too Large",
            &json!({ "ok": false, "error": "요청 본문이 허용 상한(16MiB)을 초과했습니다." }),
        );
        return;
    }

    let path_only = target.split('?').next().unwrap_or("/");
    if path_only == "/api/health" {
        write_json_response(&mut stream, "200 OK", &json!({ "ok": true, "service": "opendiy-remote" }));
        return;
    }

    if path_only.starts_with("/api/") {
        let query_token = extract_query_param(target, "token");
        let provided = bearer_token.as_deref().or(query_token.as_deref());
        if !verify_token(token_sha256.as_ref(), provided) {
            write_json_response(
                &mut stream,
                "401 Unauthorized",
                &json!({ "ok": false, "error": "유효한 원격 접속 토큰이 필요합니다." }),
            );
            return;
        }
    }

    if method == "GET" && path_only == "/api/events" {
        let _ = stream.set_read_timeout(None);
        let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
        let headers = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n: connected\n\n";
        if stream.write_all(headers.as_bytes()).is_err() || stream.flush().is_err() {
            return;
        }
        let rx = hub.subscribe();
        loop {
            match rx.recv_timeout(Duration::from_secs(15)) {
                Ok(payload) => {
                    let frame = format!("data: {payload}\n\n");
                    if stream.write_all(frame.as_bytes()).is_err() || stream.flush().is_err() {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if stream.write_all(b": keepalive\n\n").is_err() || stream.flush().is_err() {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        return;
    }

    if method == "POST" && path_only == "/api/invoke" {
        let mut body = vec![0u8; content_length];
        if reader.read_exact(&mut body).is_err() {
            write_json_response(
                &mut stream,
                "400 Bad Request",
                &json!({ "ok": false, "error": "요청 본문을 읽을 수 없습니다." }),
            );
            return;
        }
        let parsed: Value = match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(e) => {
                write_json_response(
                    &mut stream,
                    "400 Bad Request",
                    &json!({ "ok": false, "error": format!("잘못된 JSON 요청입니다: {e}") }),
                );
                return;
            }
        };
        let command = parsed.get("command").and_then(Value::as_str).unwrap_or("");
        let args = parsed.get("args").cloned().unwrap_or_else(|| json!({}));
        match dispatch_command(&engine, command, &args) {
            Ok(result) => {
                write_json_response(&mut stream, "200 OK", &json!({ "ok": true, "result": result }));
            }
            Err(error) => {
                write_json_response(&mut stream, "400 Bad Request", &json!({ "ok": false, "error": error }));
            }
        }
        return;
    }

    if method == "GET" {
        if let Some(file_path) = resolve_static_path(&dist_dir, path_only) {
            if let Ok(bytes) = fs::read(&file_path) {
                let ctype = content_type_for(&file_path);
                if file_path.file_name().and_then(|n| n.to_str()) == Some("index.html") {
                    let html = String::from_utf8_lossy(&bytes);
                    let injected = inject_remote_flag(&html);
                    write_http_response(&mut stream, "200 OK", ctype, injected.as_bytes());
                } else {
                    write_http_response(&mut stream, "200 OK", ctype, &bytes);
                }
                return;
            }
        }
        write_http_response(&mut stream, "404 Not Found", "text/plain; charset=utf-8", b"Not Found");
        return;
    }

    write_http_response(
        &mut stream,
        "405 Method Not Allowed",
        "text/plain; charset=utf-8",
        b"Method Not Allowed",
    );
}

pub fn run_from_args() -> i32 {
    if let Err(error) = process_job::install_app_job() {
        eprintln!("OpenDIY Remote job initialization failed: {error}");
        return 1;
    }

    let mut bind_addr = std::env::var("OPENDIY_REMOTE_BIND").unwrap_or_else(|_| "127.0.0.1:3210".into());
    let mut token = std::env::var("OPENDIY_REMOTE_TOKEN").ok();
    let mut dist_dir = std::env::var("OPENDIY_REMOTE_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("dist"));

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--bind" => {
                if let Some(val) = args.next() {
                    bind_addr = val;
                }
            }
            "--token" => {
                token = args.next();
            }
            "--dist" => {
                if let Some(val) = args.next() {
                    dist_dir = PathBuf::from(val);
                }
            }
            _ => {}
        }
    }

    let addr: SocketAddr = match bind_addr.parse() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("Invalid --bind address '{bind_addr}': {e}");
            return 1;
        }
    };

    let token_sha256: Option<[u8; 32]> = token
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| Sha256::digest(s.as_bytes()).into());

    if !addr.ip().is_loopback() && token_sha256.is_none() {
        eprintln!("Refusing to bind non-loopback address {addr} without --token or OPENDIY_REMOTE_TOKEN.");
        return 1;
    }

    let workspace_dir = match std::env::var_os("AGENT_GRID_WORKSPACE_DIR")
        .or_else(|| std::env::var_os("OPENDIY_REMOTE_WORKSPACE_DIR"))
    {
        Some(path) => {
            if path.is_empty() {
                eprintln!("AGENT_GRID_WORKSPACE_DIR must not be empty.");
                return 1;
            }
            let dir = PathBuf::from(path);
            if !dir.is_absolute() {
                eprintln!("AGENT_GRID_WORKSPACE_DIR must be an absolute directory path.");
                return 1;
            }
            dir
        }
        None => std::env::var_os("LOCALAPPDATA")
            .filter(|v| !v.is_empty())
            .map(|base| PathBuf::from(base).join("OpenDIYRemote"))
            .unwrap_or_else(|| std::env::temp_dir().join("opendiy-remote-workspace")),
    };
    if let Err(e) = fs::create_dir_all(&workspace_dir) {
        eprintln!("Could not create workspace directory {}: {e}", workspace_dir.display());
        return 1;
    }

    let hub = EventHub::default();
    let hub_for_sink = hub.clone();
    let sink = Arc::new(move |event: BackendEvent| -> Result<(), String> {
        match event {
            BackendEvent::Output(output) => {
                if let Ok(val) = serde_json::to_value(output) {
                    hub_for_sink.broadcast("terminal-output", val);
                }
            }
            BackendEvent::Changed(info) => {
                if let Ok(val) = serde_json::to_value(info) {
                    hub_for_sink.broadcast("session-changed", val);
                }
            }
        }
        Ok(())
    });

    let engine = match Engine::new(&workspace_dir.join("workspace.sqlite3"), sink) {
        Ok(engine) => Arc::new(engine),
        Err(error) => {
            eprintln!("OpenDIY Remote engine initialization failed: {error}");
            return 1;
        }
    };

    let listener = match TcpListener::bind(addr) {
        Ok(l) => l,
        Err(error) => {
            eprintln!("Could not bind {addr}: {error}");
            return 1;
        }
    };

    println!("OpenDIY Remote listening on http://{addr}");
    let dist_arc = Arc::new(dist_dir);
    let active_clients = Arc::new(AtomicUsize::new(0));
    for incoming in listener.incoming() {
        if let Ok(mut stream) = incoming {
            let current = active_clients.fetch_add(1, Ordering::AcqRel);
            if current >= MAX_CONCURRENT_HTTP_CLIENTS {
                active_clients.fetch_sub(1, Ordering::AcqRel);
                write_json_response(
                    &mut stream,
                    "503 Service Unavailable",
                    &json!({ "ok": false, "error": "원격 서버 동시 연결 한도에 도달했습니다." }),
                );
                continue;
            }
            let guard_counter = active_clients.clone();
            let engine = engine.clone();
            let hub = hub.clone();
            let dist = dist_arc.clone();
            std::thread::spawn(move || {
                let _guard = ActiveClientGuard(guard_counter);
                handle_client(stream, engine, hub, dist, token_sha256);
            });
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injects_remote_flag_into_head_once() {
        let html = "<!doctype html><html><head><title>Test</title></head><body></body></html>";
        let injected = inject_remote_flag(html);
        assert!(injected.contains("window.__OPENDIY_REMOTE__=true;"));
        assert_eq!(inject_remote_flag(&injected), injected);
    }

    #[test]
    fn verifies_capability_token_with_sha256() {
        let expected: [u8; 32] = Sha256::digest(b"secret-token-123").into();
        assert!(verify_token(None, None));
        assert!(verify_token(Some(&expected), Some("secret-token-123")));
        assert!(!verify_token(Some(&expected), Some("wrong-token")));
        assert!(!verify_token(Some(&expected), None));
    }

    #[test]
    fn bounded_event_hub_evicts_slow_clients_without_blocking() {
        let hub = EventHub::default();
        let slow_rx = hub.subscribe();
        let active_rx = hub.subscribe();
        for seq in 0..(MAX_SSE_CLIENT_QUEUE + 8) {
            hub.broadcast("terminal-output", json!({ "seq": seq }));
            if seq == 0 {
                // Drain one message on active_rx so it stays within capacity when we drain in lockstep.
                assert!(active_rx.try_recv().is_ok());
            }
        }
        drop(slow_rx);
        // After overflowing MAX_SSE_CLIENT_QUEUE, slow_rx's sender was evicted without blocking.
        let fresh_rx = hub.subscribe();
        hub.broadcast("session-changed", json!({ "id": "live" }));
        let msg = fresh_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(msg.contains("session-changed"));
    }

    #[test]
    fn dispatch_command_covers_project_and_chooser_contracts_on_real_engine() {
        let engine = Engine::new(Path::new(":memory:"), Arc::new(|_| Ok(()))).unwrap();
        let lang = dispatch_command(&engine, "get_ui_language", &json!({})).unwrap();
        assert_eq!(lang, json!("ko"));

        let created = dispatch_command(
            &engine,
            "create_project",
            &json!({ "name": "원격 프로젝트", "cwd": null }),
        )
        .unwrap();
        assert_eq!(created["name"], "원격 프로젝트");

        let temp_dir = std::env::temp_dir();
        let chosen = dispatch_command(
            &engine,
            "choose_project_folder",
            &json!({ "path": temp_dir.to_string_lossy() }),
        )
        .unwrap();
        assert!(chosen.as_str().is_some_and(|s| !s.is_empty()));

        assert!(dispatch_command(&engine, "open_external_url", &json!({ "url": "https://github.com" })).is_ok());
        assert!(dispatch_command(&engine, "open_external_url", &json!({ "url": "javascript:alert(1)" })).is_err());
    }
}
