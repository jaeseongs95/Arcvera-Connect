//! Opt-in checks of existing Engine controls. Never send a model turn or answer a prompt.
use crate::{codex::{ConversationRequest, CronRequest, SubagentRequest}, session::{Engine, SessionInfo, StartRequest}};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{thread, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use uuid::Uuid;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ControlsReport {
    scope: &'static str,
    session_id: Option<String>,
    checks: Vec<Check>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Check {
    name: &'static str,
    status: &'static str,
    metadata: Value,
    reason: Option<&'static str>,
}
impl ControlsReport {
    pub(super) fn new() -> Self {
        Self { scope: "First bound smoke session only; existing Engine APIs and actual responses. No model turns, terminal text/Enter, approvals, config changes, compaction, or child mutations. NOT_RUN items are not passes.", session_id: None, checks: Vec::new() }
    }
    pub(super) fn pass(&self) -> bool {
        self.checks.iter().all(|check| matches!(check.status, "PASS" | "NOT_RUN"))
            && ["runtimeCompatibility", "conversationAttach", "conversationPage", "contextStatus", "subagentsList", "pendingQuestionsList", "cronList", "cronAdd", "cronAddState", "cronPause", "cronPauseState", "cronResume", "cronResumeState", "cronRemove", "cronRemoveState", "stopBeforeResume", "sameThreadResume"]
                .iter().all(|name| self.checks.iter().any(|check| check.name == *name && check.status == "PASS"))
    }
    fn record(&mut self, name: &'static str, valid: bool, metadata: Value, reason: &'static str) -> bool {
        self.checks.push(Check { name, status: if valid { "PASS" } else { "FAIL" }, metadata, reason: (!valid).then_some(reason) });
        valid
    }
    fn not_run(&mut self, name: &'static str, reason: &'static str) {
        self.checks.push(Check { name, status: "NOT_RUN", metadata: json!({}), reason: Some(reason) });
    }
    fn response(&mut self, name: &'static str, result: Result<Value, String>, validate: impl FnOnce(&Value) -> bool, metadata: impl FnOnce(&Value) -> Value) -> Option<Value> {
        match result {
            Ok(value) => {
                let valid = validate(&value);
                self.record(name, valid, metadata(&value), "actual response did not establish the required state; no retry");
                Some(value)
            }
            Err(error) => {
                // Vendor errors may contain user text. Keep a digest, never the error body.
                self.record(name, false, json!({"errorBytes":error.len(),"errorSha256":format!("{:x}",Sha256::digest(error.as_bytes()))}), "Engine request failed; no retry");
                None
            }
        }
    }
    pub(super) fn run(&mut self, engine: &Engine, session: Option<&SessionInfo>) {
        self.not_run("compaction", "no authorized materialized-history fixture; no compaction request sent");
        self.not_run("childMutations", "no owned child fixture; no child control request sent");
        let Some(session) = session else { self.record("readySession", false, json!({}), "no smoke session established a live UUID binding"); return; };
        self.session_id = Some(session.id.clone());
        let thread_id = session.thread_id.as_deref().expect("caller selected a bound session");
        let compatibility = engine.runtime_compatibility().and_then(|value| serde_json::to_value(value).map_err(|error|error.to_string()));
        self.runtime_compatibility(compatibility);
        let attached = self.response("conversationAttach", engine.conversation_request(&session.id,session.generation,ConversationRequest::Attach),
            |v| v["threadId"]==thread_id && v["thread"]["id"]==thread_id && v["owner"]=="gui",
            |v| json!({"threadMatches":v["threadId"]==thread_id&&v["thread"]["id"]==thread_id,"guiOwner":v["owner"]=="gui","historyUnavailable":v["historyUnavailable"]==true,"activeTurnKnown":v["activeTurnKnown"]}));
        if attached.as_ref().is_some_and(|v|v["threadId"]==thread_id&&v["thread"]["id"]==thread_id&&v["owner"]=="gui") {
            let page = self.response("conversationPage", engine.conversation_request(&session.id,session.generation,ConversationRequest::Page{cursor:None}), page_valid,
                |v| json!({"historyUnavailable":v["historyUnavailable"]==true,"unmaterialized":v["historyUnavailable"]==true&&v["reason"]=="unmaterialized","turnCount":v["data"].as_array().map(Vec::len),"hasNextCursor":v["nextCursor"].is_string()}));
            if page.as_ref().is_some_and(|v|v["historyUnavailable"]==true&&v["reason"]=="unmaterialized") {
                self.not_run("materializedHistoryPage", "new no-turn fixture has explicitly unmaterialized history; no empty history substituted");
            }
        } else { self.not_run("conversationPage", "attach did not establish ownership"); }
        self.response("contextStatus", engine.conversation_request(&session.id,session.generation,ConversationRequest::ContextStatus),
            |v| v["threadId"]==thread_id && v["connected"]==true,
            |v| json!({"threadMatches":v["threadId"]==thread_id,"connected":v["connected"],"guiConnected":v["guiConnected"],
                "tokenUsageObserved":!v["tokenUsage"].is_null(),"tokenUsageFresh":v["tokenUsageFresh"],"active":v["active"],"compacting":v["compacting"],"canCompact":v["canCompact"]}));
        self.response("subagentsList", engine.subagents_request(&session.id,session.generation,SubagentRequest::List{cursor:None}),
            |v| v["supported"]==true && v["connected"]==true && v["agents"].is_array() && v["mutationState"]=="clear",
            |v| json!({"supported":v["supported"],"connected":v["connected"],"agentCount":v["agents"].as_array().map(Vec::len),"hasNextCursor":v["nextCursor"].is_string(),"mutationState":safe_state(&v["mutationState"])}));
        self.response("pendingQuestionsList", engine.list_pending_questions(),
            |v| v["items"].as_array().is_some_and(|items|items.iter().all(|item|item["metadataAvailable"]==true)),
            |v| json!({"itemCount":v["items"].as_array().map(Vec::len),"metadataUnavailableCount":v["items"].as_array().map(|items|items.iter().filter(|item|item["metadataAvailable"]!=true).count())}));
        self.cron(engine, session);
        // Every failure above still reaches the existing Harness finish path.
        self.resume(engine, session, thread_id);
    }
    fn runtime_compatibility(&mut self, result: Result<Value, String>) {
        // Engine reports the selected path; this read-only query does not confirm its version or server state.
        let selected_path_observed=|v:&Value|v["selectedServerExecutable"].as_str().is_some_and(|path|!path.trim().is_empty());
        self.response("runtimeCompatibility", result,
            |v| v["cliVersion"].is_string() && v["cliError"].is_null() && v["serverError"].is_null()
                && v["serverState"]=="unavailable" && selected_path_observed(v) && v["selectedServerVersion"].is_null() && v["compactIfIdle"].is_null(),
            |v| json!({"cliVersionObserved":v["cliVersion"].is_string(),"serverVersionObserved":v["serverVersion"].is_string(),
                "serverStateUnconfirmed":v["serverState"]=="unavailable","selectedServerExecutableObserved":selected_path_observed(v),
                "selectedServerVersionObserved":v["selectedServerVersion"].is_string(),"selectedServerVersionUnconfirmed":v["selectedServerVersion"].is_null(),
                "subagents":v["subagents"],"compactIfIdle":v["compactIfIdle"],"expectedTurnInterrupt":v["expectedTurnInterrupt"],
                "cliErrorObserved":!v["cliError"].is_null(),"serverErrorObserved":!v["serverError"].is_null()}));
    }
    fn cron(&mut self, engine: &Engine, session: &SessionInfo) {
        let mut completed = 0;
        let names = ["cronAdd", "cronPause", "cronResume", "cronRemove"];
        let result = (|| -> Option<()> {
            let initial = self.response("cronList", engine.cron_request(&session.id,session.generation,CronRequest::List{}), |v|cron_connected(v)&&v["jobs"].as_array().is_some_and(Vec::is_empty), cron_metadata)?;
            if !cron_connected(&initial) || initial["jobs"].as_array()?.len()!=0 { return None; }
            let at_unix_ms: u64 = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_millis().checked_add(365*24*60*60*1000)?.try_into().ok()?;
            completed = 1;
            let add_request = serde_json::from_value::<CronRequest>(json!({"type":"add","requestId":Uuid::new_v4().to_string(),
                "schedule":{"type":"at","atUnixMs":at_unix_ms},"prompt":"OpenDIY isolated control smoke; future fixture; remove before exit"})).ok()?;
            let add = self.response("cronAdd", engine.cron_request(&session.id,session.generation,add_request),
                |v| mutation_applied(v)&&canonical_job_id(&v["jobId"]), mutation_metadata)?;
            if !mutation_applied(&add) || !canonical_job_id(&add["jobId"]) { return None; }
            let job_id=add["jobId"].as_str()?.to_owned();
            if !self.cron_state(engine,session,"cronAddState",&job_id,Some(false),at_unix_ms) {return None;}
            for (name,action,paused) in [("cronPause",0,Some(true)),("cronResume",1,Some(false)),("cronRemove",2,None)] {
                let request_id=Uuid::new_v4().to_string();
                let request=match action {
                    0=>CronRequest::Pause{request_id,job_id:job_id.clone()},
                    1=>CronRequest::Resume{request_id,job_id:job_id.clone()},
                    _=>CronRequest::Remove{request_id,job_id:job_id.clone()},
                };
                completed+=1;
                let response=self.response(name,engine.cron_request(&session.id,session.generation,request),mutation_applied,mutation_metadata);
                if !response.as_ref().is_some_and(mutation_applied) {return None;}
                let state_name=match action {0=>"cronPauseState",1=>"cronResumeState",_=>"cronRemoveState"};
                if !self.cron_state(engine,session,state_name,&job_id,paused,at_unix_ms) {return None;}
            }
            Some(())
        })();
        if result.is_none() {
            for name in names.into_iter().skip(completed) {self.not_run(name,"prior reservation check failed or was unknown; no follow-up mutation sent; owned CLI is cleaned by Harness");}
            for name in ["cronAddState","cronPauseState","cronResumeState","cronRemoveState"] {
                if !self.checks.iter().any(|check|check.name==name) {self.not_run(name,"prior reservation check did not establish the required state");}
            }
        }
    }
    fn cron_state(&mut self,engine:&Engine,session:&SessionInfo,name:&'static str,job_id:&str,paused:Option<bool>,at_unix_ms:u64)->bool {
        let valid=|value:&Value| {
            if !cron_connected(value) {return false;}
            let Some(jobs)=value["jobs"].as_array() else {return false;};
            let job=jobs.iter().find(|job|job["id"]==job_id);
            match paused {
                Some(paused)=>job.is_some_and(|job|job["paused"]==paused&&job["removed"]==false&&job["schedule"]["type"]=="at"&&job["schedule"]["atUnixMs"]==at_unix_ms&&job["state"]=="ready"),
                None=>job.is_none_or(|job|job["removed"]==true && matches!(job["state"].as_str(),Some("ready"|"finished"))),
            }
        };
        self.response(name,engine.cron_request(&session.id,session.generation,CronRequest::List{}),valid,cron_metadata).as_ref().is_some_and(valid)
    }
    fn resume(&mut self,engine:&Engine,session:&SessionInfo,thread_id:&str) {
        let stopped=engine.stop(&session.id,session.generation).and_then(|_|engine.wait_for_exit(&session.id,session.generation,Duration::from_secs(10)));
        let stopped=self.response("stopBeforeResume",stopped.and_then(|info|serde_json::to_value(info).map_err(|e|e.to_string())),
            |v|v["state"]=="stopped"&&v["active"]==false&&v["threadId"]==thread_id,
            |v|json!({"stopped":v["state"]=="stopped","active":v["active"],"threadMatches":v["threadId"]==thread_id}));
        if !stopped.as_ref().is_some_and(|v|v["state"]=="stopped"&&v["active"]==false&&v["threadId"]==thread_id) {self.not_run("sameThreadResume","original session stop was not confirmed");return;}
        let result=(||->Result<Value,String>{
            let resumed=engine.start(StartRequest{cwd:session.cwd.clone(),title:"Codex control smoke resume".into(),project_id:None,project_assigned:false,thread_id:Some(thread_id.into()),cols:100,rows:30})?;
            let deadline=Instant::now()+Duration::from_secs(45);
            loop {
                let sessions=engine.list()?;
                let info=sessions.iter().find(|info|info.id==resumed.id).ok_or("resumed smoke session was not listed")?;
                if info.thread_id.as_deref()!=Some(thread_id) {return Err("resumed smoke session changed thread identity".into());}
                if info.active && matches!(info.state.as_str(),"idle"|"running"|"waiting") {
                    return Ok(json!({"sameThread":true,"newSession":info.id!=session.id,"active":info.active,"liveStatusObserved":true}));
                }
                if matches!(info.state.as_str(),"error"|"stopped"|"exited") || Instant::now()>=deadline {return Err("resumed smoke session did not establish live status within deadline".into());}
                thread::sleep(Duration::from_millis(100));
            }
        })();
        self.response("sameThreadResume",result,|v|v["sameThread"]==true&&v["newSession"]==true&&v["active"]==true&&v["liveStatusObserved"]==true,Clone::clone);
    }
}
fn page_valid(value:&Value)->bool {
    if value["historyUnavailable"]==true {value["reason"]=="unmaterialized"&&value.get("data").is_none()}
    else {value["data"].is_array()}
}
fn canonical_job_id(value:&Value)->bool {
    value.as_str().is_some_and(|id|id.parse::<u64>().is_ok_and(|n|n>0&&n.to_string()==id))
}
fn mutation_applied(value:&Value)->bool {value["status"]=="applied"}
fn safe_state(value:&Value)->Value {
    match value.as_str() {Some(state @ ("clear"|"unknown"|"applied"|"notApplied"|"unsupported"))=>json!(state),_=>Value::Null}
}
fn mutation_metadata(value:&Value)->Value {json!({"status":safe_state(&value["status"]),"jobIdObserved":canonical_job_id(&value["jobId"])})}
fn cron_connected(value:&Value)->bool {
    value["supported"]==true&&value["connected"]==true&&value["scope"]=="cliLifetime"&&value["jobs"].is_array()&&value["hasMore"]==false&&value["mutationState"]!="unknown"
}
fn cron_metadata(value:&Value)->Value {
    json!({"supported":value["supported"],"connected":value["connected"],"cliLifetimeScope":value["scope"]=="cliLifetime","jobCount":value["jobs"].as_array().map(Vec::len),"hasMore":value["hasMore"],"mutationState":safe_state(&value["mutationState"])})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn control_smoke_uses_engine_selected_path_without_confirming_server_version() {
        // Public Engine response shape: inspect_runtime leaves state/version unconfirmed,
        // then Engine::runtime_compatibility fills the configured server executable.
        let actual=serde_json::to_value(crate::codex::RuntimeCompatibility {
            executable:"fixture-cli.exe".into(),cli_version:Some("cli-v3".into()),cli_error:None,
            server_state:"unavailable",server_version:Some("server-v3".into()),
            selected_server_executable:Some("private-fixture-server.exe".into()),selected_server_version:None,server_error:None,
            subagents:Some(true),compact_if_idle:None,expected_turn_interrupt:Some(true),
        }).unwrap();
        let mut report=ControlsReport::new();
        report.runtime_compatibility(Ok(actual.clone()));
        let check=&report.checks[0];
        assert_eq!(check.status,"PASS");
        assert_eq!(check.metadata["selectedServerExecutableObserved"],true);
        assert_eq!(check.metadata["selectedServerVersionObserved"],false);
        assert_eq!(check.metadata["selectedServerVersionUnconfirmed"],true);
        assert_eq!(check.metadata["serverStateUnconfirmed"],true);
        assert_eq!(check.metadata["serverVersionObserved"],true);
        assert!(!serde_json::to_string(&report).unwrap().contains("private-fixture-server.exe"));
        for (key,value) in [
            ("selectedServerExecutable",Value::Null),("selectedServerExecutable",json!("")),
            ("selectedServerExecutable",json!("  ")),("selectedServerExecutable",json!(42)),
            ("cliVersion",Value::Null),("cliError",json!("private error")),("serverError",json!("private error")),
            ("serverState",json!("unknown")),("serverState",json!("unsupported")),
            ("selectedServerVersion",json!("unexpected confirmation")),("compactIfIdle",json!(true)),
        ] {
            let mut changed=actual.clone();
            changed[key]=value;
            let mut report=ControlsReport::new();
            report.runtime_compatibility(Ok(changed));
            assert_eq!(report.checks[0].status,"FAIL","{key}");
            assert!(!serde_json::to_string(&report).unwrap().contains("private error"));
        }
        let mut missing=actual;
        missing.as_object_mut().unwrap().remove("selectedServerExecutable");
        let mut report=ControlsReport::new();
        report.runtime_compatibility(Ok(missing));
        report.runtime_compatibility(Err("private error".into()));
        assert_eq!(report.checks.iter().map(|check|check.status).collect::<Vec<_>>(),["FAIL","FAIL"]);
        assert!(!serde_json::to_string(&report).unwrap().contains("private error"));
    }
    #[test]
    fn control_smoke_rejects_unknown_disconnected_and_non_applied_results_without_payload_leaks() {
        assert!(page_valid(&json!({"historyUnavailable":true,"reason":"unmaterialized"})));
        assert!(!page_valid(&json!({"historyUnavailable":true,"reason":"unmaterialized","data":[]})));
        assert!(!page_valid(&json!({"historyUnavailable":true,"reason":"other"})));
        for status in ["unknown","notApplied","unsupported",""] {assert!(!mutation_applied(&json!({"status":status})));}
        assert!(mutation_applied(&json!({"status":"applied"})));
        let valid=json!({"supported":true,"connected":true,"scope":"cliLifetime","jobs":[],"hasMore":false});
        assert!(cron_connected(&valid));
        for (key,value) in [("connected",json!(false)),("supported",json!(false)),("mutationState",json!("unknown")),("hasMore",json!(true))] {let mut changed=valid.clone();changed[key]=value;assert!(!cron_connected(&changed));}
        for id in ["0","01","-1","18446744073709551616"] {assert!(!canonical_job_id(&json!(id)));}
        let mut report=ControlsReport::new();
        report.response("failed",Err("secret user text".into()),|_|true,|_|json!({}));
        report.response("unknown",Ok(json!({"status":"unknown","prompt":"secret user text"})),mutation_applied,mutation_metadata);
        assert!(!report.pass());
        let serialized=serde_json::to_string(&report).unwrap();
        assert!(!serialized.contains("secret user text"));
        assert_eq!(report.checks.iter().map(|check|check.status).collect::<Vec<_>>(),["FAIL","FAIL"]);
    }
}
