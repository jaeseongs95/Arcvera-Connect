//! Bounded hook metadata and CLI-owned user-state mutations.
use super::*;
use std::collections::HashSet;

const MAX_DIAGNOSTICS: usize = 128;
const MAX_TEXT: usize = 64 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionHook {
    pub key: String, pub event_name: String, pub handler_type: String,
    pub command: Option<String>, pub server: Option<String>, pub tool: Option<String>,
    #[serde(rename = "async")]
    pub asynchronous: bool,
    pub matcher: Option<String>, pub timeout_sec: u64, pub status_message: Option<String>,
    pub additional_context_limit: Option<u64>, pub source_path: String, pub source: String,
    pub plugin_id: Option<String>, pub enabled: bool, pub is_managed: bool,
    pub current_hash: String, pub trust_status: String,
}
#[derive(Debug, Serialize)]
pub struct ExtensionHookError { pub path: String, pub message: String }
#[derive(Debug, Serialize)]
pub struct ExtensionHooks {
    pub items: Vec<ExtensionHook>, pub warnings: Vec<String>, pub errors: Vec<ExtensionHookError>,
}

fn enum_text(value: &Value, key: &str, allowed: &[&str]) -> Result<String, String> {
    let result = text(value, key, 128)?;
    if !allowed.contains(&result.as_str()) { return Err(format!("Hook response has an unsupported {key}")); }
    Ok(result)
}
fn optional_display(value: &Value, key: &str, maximum: usize) -> Result<Option<String>, String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.len() <= maximum => Ok(Some(value.clone())),
        _ => Err(format!("Hook response has an invalid {key}")),
    }
}
fn unsigned(value: &Value, key: &str) -> Result<u64, String> {
    value[key].as_u64().filter(|number| *number <= 9_007_199_254_740_991)
        .ok_or_else(|| format!("Hook response has an invalid {key}"))
}
fn boolean(value: &Value, key: &str) -> Result<bool, String> {
    value[key].as_bool().ok_or_else(|| format!("Hook response has an invalid {key}"))
}
fn parse_hook(value: &Value) -> Result<ExtensionHook, String> {
    let handler_type = enum_text(value, "handlerType", &["command", "mcpTool", "prompt", "agent"])?;
    let (command, server, tool, asynchronous) = match handler_type.as_str() {
        "command" => (Some(text(value, "command", MAX_TEXT)?), None, None,
            match value.get("async") { None => false, Some(_) => boolean(value, "async")? }),
        "mcpTool" => (None, Some(text(value, "server", 1024)?), Some(text(value, "tool", 1024)?), false),
        _ => (None, None, None, false),
    };
    let source_path = text(value, "sourcePath", 128 * 1024)?;
    if !Path::new(&source_path).is_absolute() { return Err("Hook response has a relative sourcePath".into()); }
    let key = text(value, "key", 4096)?;
    argument(&key, "Hook key", 4096)?;
    let current_hash = text(value, "currentHash", 4096)?;
    argument(&current_hash, "Hook hash", 4096)?;
    Ok(ExtensionHook {
        key, current_hash, handler_type, command, server, tool, asynchronous,
        event_name: enum_text(value, "eventName", &["preModelRequest", "postModelRequest", "preToolUse", "permissionRequest", "postToolUse", "preCompact", "postCompact", "sessionStart", "sessionEnd", "userPromptSubmit", "subagentStart", "subagentStop", "stop", "interrupt"])?,
        matcher: optional_display(value, "matcher", MAX_TEXT)?, timeout_sec: unsigned(value, "timeoutSec")?,
        status_message: optional_display(value, "statusMessage", MAX_TEXT)?,
        additional_context_limit: if value["additionalContextLimit"].is_null() { None } else { Some(unsigned(value, "additionalContextLimit")?) },
        source_path, source: enum_text(value, "source", &["system", "user", "project", "mdm", "sessionFlags", "plugin", "cloudRequirements", "cloudManagedConfig", "legacyManagedConfigFile", "legacyManagedConfigMdm", "unknown"])?,
        plugin_id: optional_display(value, "pluginId", 512)?, enabled: boolean(value, "enabled")?,
        is_managed: boolean(value, "isManaged")?,
        trust_status: enum_text(value, "trustStatus", &["managed", "untrusted", "trusted", "modified"])?,
    })
}
fn same_directory(first: &Path, second: &Path) -> bool {
    first == second || first.canonicalize().ok().zip(second.canonicalize().ok()).is_some_and(|(a, b)| a == b)
}
fn parse(value: &Value, directory: &Path) -> Result<ExtensionHooks, String> {
    let entries = rows(value, "data")?;
    if entries.len() != 1 { return Err("Hook response must contain exactly the requested project entry".into()); }
    let entry = &entries[0];
    if !same_directory(Path::new(&text(entry, "cwd", 128 * 1024)?), directory) { return Err("Hook response belongs to a different project".into()); }
    let mut keys = HashSet::new();
    let items = rows(entry, "hooks")?.iter().map(|value| {
        let hook = parse_hook(value)?;
        if !keys.insert(hook.key.clone()) { return Err("Hook response contains duplicate keys; no hook can be changed".into()); }
        Ok(hook)
    }).collect::<Result<Vec<_>, String>>()?;
    let warnings = bounded_rows(entry, "warnings", MAX_DIAGNOSTICS)?.iter().map(|value|
        value.as_str().filter(|value| value.len() <= MAX_TEXT).map(str::to_owned).ok_or_else(|| "Hook response has an invalid warning".to_owned())
    ).collect::<Result<_, _>>()?;
    let errors = bounded_rows(entry, "errors", MAX_DIAGNOSTICS)?.iter().map(|value| Ok(ExtensionHookError {
        path: optional_display(value, "path", 128 * 1024)?.ok_or("Hook error has no path")?,
        message: optional_display(value, "message", MAX_TEXT)?.ok_or("Hook error has no message")?,
    })).collect::<Result<_, String>>()?;
    Ok(ExtensionHooks { items, warnings, errors })
}

// Never relay an RPC's arbitrary diagnostic text: it may quote hook commands or
// config values. Preserve the useful failure class without logging its content.
fn call(rpc: &mut impl FnMut(&str, Value) -> Result<Value, String>, method: &str, params: Value) -> Result<Value, String> {
    rpc(method, params).map_err(|error| {
        let class = if error.contains("configVersionConflict") || error.contains("Configuration was modified since last read") { "설정 버전이 바뀌었습니다. 덮어쓰지 않았습니다" }
            else if error.contains("configRequirementReadonly") || error.contains("configLayerReadonly") || error.contains("Only writes to the user config are allowed") || error.contains("is managed by requirements and cannot be changed") { "관리 정책 또는 읽기 전용 설정이 변경을 거부했습니다" }
            else if error.contains("-32601") || error.contains("Method not found") || error.contains("method not found") { "선택한 CLI가 이 Hook 관리 요청을 지원하지 않습니다" }
            else if error.contains("timed out") || error.contains("기한") { "요청 시간이 초과되어 결과를 확인하지 못했습니다" }
            else if error.contains("transport") || error.contains("disconnect") { "CLI 연결이 끊어져 결과를 확인하지 못했습니다" }
            else { "CLI 요청이 실패하여 결과를 확인하지 못했습니다" };
        format!("{method}: {class}. 새로고침 후 확인하세요.")
    })
}
pub(super) fn list(directory: &Path, rpc: &mut impl FnMut(&str, Value) -> Result<Value, String>) -> Result<ExtensionHooks, String> {
    parse(&call(rpc, "hooks/list", json!({"cwds":[directory]}))?, directory)
}

#[derive(Clone, Copy)]
pub(super) enum HookChange { Enabled(bool), Trust }

pub(super) fn mutate(directory: &Path, key: &str, current_hash: &str, change: HookChange,
    rpc: &mut impl FnMut(&str, Value) -> Result<Value, String>) -> Result<(), String> {
    argument(key, "Hook key", 4096)?;
    argument(current_hash, "Hook hash", 4096)?;
    let config = call(rpc, "config/read", json!({"includeLayers":true,"cwd":directory}))?;
    let layers = rows(&config, "layers")?;
    let mut users = layers.iter().filter(|layer| layer["name"]["type"] == "user" && layer["name"]["profile"].is_null());
    let layer = users.next().ok_or("Hook 설정을 쓸 사용자 계층이 없습니다. 변경하지 않았습니다.")?;
    if users.next().is_some() { return Err("Hook 사용자 설정 계층이 중복되었습니다. 변경하지 않았습니다.".into()); }
    let file = text(&layer["name"], "file", 128 * 1024)?;
    if !Path::new(&file).is_absolute() { return Err("Hook 사용자 설정 경로가 절대 경로가 아닙니다. 변경하지 않았습니다.".into()); }
    let version = text(layer, "version", 4096)?;
    // Last inventory before write: config CAS protects user state, while this
    // opaque hash guard binds approval to the exact displayed hook content.
    let before = list(directory, rpc)?;
    if !before.errors.is_empty() { return Err("Hook 목록에 오류가 있습니다. 원인을 해결한 뒤 변경하세요.".into()); }
    let selected = before.items.iter().find(|hook| hook.key == key).ok_or("선택한 Hook이 현재 목록에 없습니다. 변경하지 않았습니다.")?;
    if selected.current_hash != current_hash { return Err("Hook 내용이 바뀌었습니다. 새 내용을 검토하기 전에는 변경할 수 없습니다.".into()); }
    if selected.is_managed || selected.trust_status == "managed" { return Err("관리 Hook은 사용자 설정으로 변경할 수 없습니다.".into()); }
    // MCP metadata omits input and prompt/agent metadata omits the body. Their
    // opaque hashes cannot substitute for reviewing all executable content.
    if matches!(change, HookChange::Trust) && selected.handler_type != "command" {
        return Err("이 Hook 형식은 실행 내용 전체를 조회할 수 없어 이 화면에서 신뢰 승인할 수 없습니다.".into());
    }
    if matches!(change, HookChange::Enabled(true)) && selected.trust_status != "trusted" {
        return Err("Hook 내용을 검토하고 현재 해시를 신뢰 승인한 뒤 활성화하세요.".into());
    }
    if matches!(change, HookChange::Trust) && !matches!(selected.trust_status.as_str(), "untrusted" | "modified") {
        return Err("현재 Hook은 신뢰 검토 대상이 아닙니다. 새로고침하세요.".into());
    }
    let patch = match change { HookChange::Enabled(enabled) => json!({"enabled":enabled}), HookChange::Trust => json!({"trusted_hash":current_hash}) };
    let response = call(rpc, "config/batchWrite", json!({
        "edits":[{"keyPath":"hooks.state","value":{key:patch},"mergeStrategy":"upsert"}],
        "filePath":file,"expectedVersion":version,"reloadUserConfig":true,
    }))?;
    // ConfigWriteResponse has no per-thread refresh results. This verifies only
    // the selected project inventory, never all loaded conversations.
    let after = list(directory, rpc)?;
    if !after.errors.is_empty() { return Err("Hook 설정을 저장했지만 재조회 오류로 적용 상태를 확인하지 못했습니다.".into()); }
    if response["status"] == "okOverridden" || !response["overriddenMetadata"].is_null() {
        return Err("Hook 설정을 저장했지만 상위 정책이 덮어씁니다. 실제 적용을 확인하세요.".into());
    }
    if response["status"] != "ok" { return Err("Hook 쓰기 응답의 성공 상태를 확인하지 못했습니다. 새로고침하세요.".into()); }
    let actual = after.items.iter().find(|hook| hook.key == key).ok_or("Hook 설정을 저장했지만 대상이 재조회 목록에서 사라졌습니다.")?;
    if actual.current_hash != current_hash || actual.is_managed || actual.trust_status == "managed" {
        return Err("Hook 설정을 저장했지만 내용 또는 관리 정책이 바뀌었습니다. 새로 검토하세요.".into());
    }
    let verified = match change {
        HookChange::Enabled(enabled) => actual.enabled == enabled && (!enabled || actual.trust_status == "trusted"),
        HookChange::Trust => actual.trust_status == "trusted" && actual.enabled == selected.enabled,
    };
    if !verified { return Err("Hook 설정을 저장했지만 실제 상태가 요청과 다릅니다. 자동 재시도하지 않고 새로고침하세요.".into()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn directory() -> PathBuf { env::current_dir().unwrap() }
    fn hook() -> Value {
        json!({"key":"project.x.\"quoted\"", "currentHash":"opaque:plugin:hash", "handlerType":"command",
            "command":"echo <script>literal</script>", "async":false, "eventName":"preToolUse", "matcher":null,
            "timeoutSec":10, "statusMessage":null, "additionalContextLimit":null,
            "sourcePath":directory().join("hooks.json"), "source":"project", "pluginId":null,
            "displayOrder":0, "enabled":true, "isManaged":false, "trustStatus":"trusted"})
    }
    fn inventory(hooks: Vec<Value>) -> Value {
        json!({"data":[{"cwd":directory(),"hooks":hooks,"warnings":[],"errors":[]}]})
    }
    fn handler_hook(handler: &str) -> Value {
        let mut hook = hook();
        hook["handlerType"] = json!(handler);
        if handler != "command" {
            hook.as_object_mut().unwrap().remove("command");
            hook.as_object_mut().unwrap().remove("async");
        }
        if handler == "mcpTool" { hook["server"] = json!("fixture-server"); hook["tool"] = json!("fixture-tool"); }
        hook
    }
    fn config() -> Value {
        json!({"layers":[{"name":{"type":"user","file":directory().join("config.toml"),"profile":null},"version":"version-before"}]})
    }
    fn write_response() -> Value {
        json!({"status":"ok","version":"version-after","filePath":directory().join("config.toml"),"overriddenMetadata":null})
    }
    fn exercise(before: Value, after: Value, change: HookChange, response: Result<Value, String>) -> (Result<(), String>, Vec<(String, Value)>) {
        let mut replies = VecDeque::from([
            ("config/read", Ok(config())), ("hooks/list", Ok(inventory(vec![before]))),
            ("config/batchWrite", response), ("hooks/list", Ok(inventory(vec![after]))),
        ]);
        let mut requests = Vec::new();
        let result = mutate(&directory(), "project.x.\"quoted\"", "opaque:plugin:hash", change, &mut |method, params| {
            requests.push((method.to_owned(), params));
            let (expected, result) = replies.pop_front().expect("unexpected extra RPC (including automatic retry)");
            assert_eq!(method, expected);
            result
        });
        (result, requests)
    }

    // HK01 / HK05: independent DTO examples from generated HookMetadata schema.
    #[test]
    fn metadata_preserves_literal_command_and_all_handler_variants() {
        let mut command = hook(); command["async"] = json!(true);
        let mut mcp = hook(); mcp["key"] = json!("mcp"); mcp["handlerType"] = json!("mcpTool");
        mcp["server"] = json!("local"); mcp["tool"] = json!("inspect"); mcp.as_object_mut().unwrap().remove("command");
        let mut prompt = hook(); prompt["key"] = json!("prompt"); prompt["handlerType"] = json!("prompt"); prompt.as_object_mut().unwrap().remove("command");
        let mut agent = prompt.clone(); agent["key"] = json!("agent"); agent["handlerType"] = json!("agent");
        let parsed = parse(&inventory(vec![command, mcp, prompt, agent]), &directory()).unwrap();
        assert_eq!(parsed.items.len(), 4);
        let output = serde_json::to_value(&parsed).unwrap();
        assert_eq!(output["items"][0]["command"], "echo <script>literal</script>");
        assert_eq!(output["items"][0]["async"], true);
        assert_eq!(output["items"][1]["handlerType"], "mcpTool");
        assert_eq!(output["items"][1]["tool"], "inspect");
        assert!(output["items"][2]["command"].is_null());
        assert_eq!(output["items"][3]["handlerType"], "agent");
    }
    #[test]
    fn malformed_duplicate_and_oversize_inventory_is_rejected() {
        assert!(parse(&inventory(vec![hook(), hook()]), &directory()).unwrap_err().contains("duplicate"));
        for (key, value) in [("enabled", json!("true")), ("isManaged", Value::Null), ("handlerType", json!("shell")),
            ("eventName", json!("unknown")), ("timeoutSec", json!(-1)), ("command", json!("x".repeat(MAX_TEXT+1))),
            ("currentHash", json!("")), ("sourcePath", json!("relative/path"))] {
            let mut invalid = hook(); invalid[key] = value;
            assert!(parse(&inventory(vec![invalid]), &directory()).is_err(), "accepted invalid {key}");
        }
        assert!(parse(&inventory(vec![hook(); MAX_ROWS+1]), &directory()).is_err());
        let mut wrong_context = inventory(vec![]); wrong_context["data"][0]["cwd"] = json!(directory().join("different"));
        assert!(parse(&wrong_context, &directory()).unwrap_err().contains("different project"));
        assert!(parse(&json!({"data":[]}), &directory()).is_err());
    }
    #[test]
    fn partial_diagnostics_are_preserved_and_bounded() {
        let mut value = inventory(vec![hook()]);
        value["data"][0]["warnings"] = json!(["unsupported handler"]);
        value["data"][0]["errors"] = json!([{"path":"fixture.json","message":"invalid hook"}]);
        let parsed = parse(&value, &directory()).unwrap();
        assert_eq!(parsed.items.len(), 1);
        assert_eq!(parsed.warnings, ["unsupported handler"]);
        assert_eq!(parsed.errors[0].path, "fixture.json");
        value["data"][0]["errors"][0]["path"] = json!("");
        assert_eq!(parse(&value, &directory()).unwrap().errors[0].path, "");
        value["data"][0]["warnings"] = json!(vec!["warning"; MAX_DIAGNOSTICS+1]);
        assert!(parse(&value, &directory()).is_err());
    }
    // HK03 / HK05: literal JSON key, fixed keyPath and exact CAS request.
    #[test]
    fn toggle_uses_exact_user_layer_version_and_literal_key_then_checks_readback() {
        let mut after = hook(); after["enabled"] = json!(false);
        let (result, requests) = exercise(hook(), after, HookChange::Enabled(false), Ok(write_response()));
        result.unwrap();
        assert_eq!(requests.len(), 4);
        assert_eq!(requests[0].1, json!({"includeLayers":true,"cwd":directory()}));
        assert_eq!(requests[1].1, json!({"cwds":[directory()]}));
        assert_eq!(requests[2].1, json!({
            "edits":[{"keyPath":"hooks.state","value":{"project.x.\"quoted\"":{"enabled":false}},"mergeStrategy":"upsert"}],
            "filePath":directory().join("config.toml"),"expectedVersion":"version-before","reloadUserConfig":true,
        }));
        assert_eq!(requests[3].1, json!({"cwds":[directory()]}));
    }
    // HK04: trust binds the opaque hash and never changes enablement.
    #[test]
    fn trust_only_upserts_current_opaque_hash_without_enabling() {
        for trust in ["untrusted", "modified"] {
            let mut before = hook(); before["trustStatus"] = json!(trust); before["enabled"] = json!(false);
            let mut after = before.clone(); after["trustStatus"] = json!("trusted");
            let (result, requests) = exercise(before, after, HookChange::Trust, Ok(write_response()));
            result.unwrap();
            assert_eq!(requests[2].1["edits"][0]["value"], json!({"project.x.\"quoted\"":{"trusted_hash":"opaque:plugin:hash"}}));
            assert!(requests[2].1["edits"][0]["value"]["project.x.\"quoted\""].get("enabled").is_none());
        }
    }
    #[test]
    fn incomplete_handler_metadata_cannot_authorize_trust() {
        for handler in ["mcpTool", "prompt", "agent"] {
            for trust in ["untrusted", "modified"] {
                let mut before = handler_hook(handler); before["trustStatus"] = json!(trust);
                let mut after = before.clone(); after["trustStatus"] = json!("trusted");
                let (result, requests) = exercise(before, after, HookChange::Trust, Ok(write_response()));
                assert!(result.unwrap_err().contains("실행 내용 전체"));
                assert_eq!(requests.len(), 2, "{handler} must never reach config/batchWrite");
            }
        }
    }
    #[test]
    fn already_trusted_mcp_hook_toggle_keeps_exact_write_and_readback_contract() {
        for enabled in [false, true] {
            let mut before = handler_hook("mcpTool"); before["enabled"] = json!(!enabled);
            let mut after = before.clone(); after["enabled"] = json!(enabled);
            let (result, requests) = exercise(before, after, HookChange::Enabled(enabled), Ok(write_response()));
            result.unwrap();
            assert_eq!(requests.len(), 4);
            assert_eq!(requests[2].1["edits"][0], json!({"keyPath":"hooks.state","value":{"project.x.\"quoted\"":{"enabled":enabled}},"mergeStrategy":"upsert"}));
            assert_eq!(requests[2].1["expectedVersion"], "version-before");
            assert_eq!(requests[3].0, "hooks/list");
        }
    }
    #[test]
    fn modified_or_untrusted_hook_cannot_be_enabled_but_can_be_disabled() {
        for handler in ["command", "mcpTool", "prompt", "agent"] {
            for trust in ["modified", "untrusted"] {
                let mut before = handler_hook(handler); before["trustStatus"] = json!(trust);
                let (result, requests) = exercise(before.clone(), before.clone(), HookChange::Enabled(true), Ok(write_response()));
                assert!(result.is_err()); assert_eq!(requests.len(), 2);
                let mut after = before.clone(); after["enabled"] = json!(false);
                exercise(before, after, HookChange::Enabled(false), Ok(write_response())).0.unwrap();
            }
        }
    }
    // HK04 / HK11: policy or content changes must fail before any write.
    #[test]
    fn managed_policy_and_stale_hash_reject_every_mutation_before_write() {
        for change in [HookChange::Enabled(false), HookChange::Enabled(true), HookChange::Trust] {
            for handler in ["command", "mcpTool", "prompt", "agent"] {
                for field in ["isManaged", "trustStatus", "currentHash"] {
                    let mut before = handler_hook(handler); before[field] = match field { "isManaged" => json!(true), "trustStatus" => json!("managed"), _ => json!("new-hash") };
                    let (result, requests) = exercise(before, hook(), change, Ok(write_response()));
                    let error = result.unwrap_err();
                    assert!(error.contains(if field == "currentHash" { "내용이 바뀌었습니다" } else { "관리 Hook" }));
                    assert_eq!(requests.len(), 2);
                }
            }
        }
    }
    // HK06: no retry; version conflict and policy override are not success.
    #[test]
    fn conflict_is_reported_without_retry_or_sensitive_error_text() {
        for message in ["configVersionConflict secret-command-value", "Configuration was modified since last read. Fetch latest version and retry. secret-command-value"] {
            let (result, requests) = exercise(hook(), hook(), HookChange::Enabled(false), Err(message.into()));
            let error = result.unwrap_err();
            assert!(error.contains("버전")); assert!(!error.contains("secret-command-value")); assert_eq!(requests.len(), 3);
        }
    }
    #[test]
    fn readback_rejects_policy_override_hash_change_and_unchanged_enabled_state() {
        let mut disabled = hook(); disabled["enabled"] = json!(false);
        let mut overridden = write_response(); overridden["status"] = json!("okOverridden");
        assert!(exercise(hook(), disabled.clone(), HookChange::Enabled(false), Ok(overridden)).0.is_err());
        let mut changed = disabled; changed["currentHash"] = json!("changed-after-write");
        assert!(exercise(hook(), changed, HookChange::Enabled(false), Ok(write_response())).0.is_err());
        assert!(exercise(hook(), hook(), HookChange::Enabled(false), Ok(write_response())).0.is_err());
        let mut untrusted = hook(); untrusted["trustStatus"] = json!("untrusted");
        let mut unexpectedly_enabled = hook(); unexpectedly_enabled["enabled"] = json!(false);
        assert!(exercise(untrusted, unexpectedly_enabled, HookChange::Trust, Ok(write_response())).0.is_err());
    }
    // HK07: unsupported/transport failures cannot become successful empty lists.
    #[test]
    fn unsupported_and_transport_failures_keep_failure_class_without_raw_content() {
        for (raw, expected) in [("-32601 secret-command", "지원"), ("Codex transport read failed: secret-command", "연결"), ("Codex hooks/list timed out secret-command", "초과")] {
            let error = list(&directory(), &mut |_, _| Err(raw.into())).unwrap_err();
            assert!(error.contains(expected)); assert!(!error.contains("secret-command"));
        }
    }
    #[test]
    fn renderer_mutations_reject_arbitrary_fields() {
        assert!(serde_json::from_value::<ExtensionMutation>(json!({"operation":"trustHook","key":"k","currentHash":"h","enabled":true})).is_err());
        assert!(serde_json::from_value::<ExtensionMutation>(json!({"operation":"setHookEnabled","key":"k","currentHash":"h","enabled":true,"keyPath":"anything"})).is_err());
        assert!(serde_json::from_value::<ExtensionMutation>(json!({"operation":"trustHook","key":"k","currentHash":"h"})).is_ok());
    }
}
