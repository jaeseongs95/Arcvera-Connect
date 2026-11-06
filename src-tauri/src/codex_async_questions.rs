//! R36 async AgentMessage questions are ordinary user input, never JSON-RPC replies.
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

const MAX_QUESTIONS: usize = 32;
const MAX_IDENTITIES: usize = 1024;
pub(super) const HISTORY_ITEMS: usize = 128;
pub(super) const HISTORY_BYTES: usize = 1024 * 1024;
const OPEN: &str = "<send_user_message_question_reply>";
const CLOSE: &str = "</send_user_message_question_reply>";

#[derive(Default)]
pub(super) struct State {
    turn: Option<String>,
    current_closed: bool,
    closed: HashSet<String>,
    seen: HashSet<String>,
    answered: HashSet<String>,
    pending: BTreeMap<String, Value>,
    complete: bool,
    diagnostic: Option<String>,
    pub(super) revision: u64,
}

pub(super) fn is_question_id(id: &str) -> bool {
    if id.len()>512 {return false;}
    let Ok(Value::Array(parts)) = serde_json::from_str::<Value>(id) else { return false; };
    parts.len() == 3 && parts[0] == "request_user_input_async" && parts[1].is_string() && parts[2].as_u64().is_some()
}

impl State {
    pub(super) fn unavailable(&mut self, reason: &str) {
        self.complete = false;
        self.diagnostic = Some(reason.into());
    }
    pub(super) fn clear(&mut self) { *self = Self::default(); }
    pub(super) fn complete(&self) -> bool { self.complete }
    pub(super) fn active_turn_id(&self) -> Option<&str> { self.turn.as_deref().filter(|_|!self.current_closed) }
    pub(super) fn closed_turn_matches(&self, turn: &str) -> bool { self.current_closed && self.turn.as_deref()==Some(turn) }
    pub(super) fn diagnostic(&self) -> Option<&str> { self.diagnostic.as_deref() }
    pub(super) fn has_attempt(&self) -> bool { self.pending.values().any(|request|request["responded"]==true) }
    pub(super) fn snapshot(&self, fresh: bool) -> Vec<Value> {
        self.pending.values().map(|request| {
            let mut request = request.clone();
            request["metadataAvailable"] = json!(fresh);
            if let Some(reason)=self.diagnostic() {request["metadataDiagnostic"]=json!(reason);}
            request
        }).collect()
    }
    fn close(&mut self, turn: &str) {
        if self.closed.len() < MAX_IDENTITIES { self.closed.insert(turn.into()); }
        if self.turn.as_deref() == Some(turn) {
            // The current turn's tombstone is independent of the bounded old-ID
            // set. Saturation must never reopen the just-completed turn.
            self.current_closed = true;
            self.pending.clear(); self.seen.clear(); self.answered.clear();
            self.complete=true;self.diagnostic=None;
            // Retain the turn identity so a late item cannot reopen it.
        }
    }
    fn begin(&mut self, turn: &str, complete: bool) {
        if self.closed.contains(turn) || (self.turn.as_deref()==Some(turn) && self.current_closed) { return; }
        if self.turn.as_deref() != Some(turn) {
            if let Some(previous) = self.turn.clone() { self.close(&previous); }
            self.turn = Some(turn.into());
            self.current_closed = false;
            self.pending.clear(); self.seen.clear(); self.answered.clear();
        }
        if complete { self.complete = true; self.diagnostic = None; }
    }
    pub(super) fn idle(&mut self) {
        if let Some(turn) = self.turn.clone() { self.close(&turn); }
        self.pending.clear(); self.complete = true; self.diagnostic = None;
    }
    pub(super) fn observe(&mut self, method: &str, params: &Value) {
        let turn = params["turn"]["id"].as_str().or_else(|| params["turnId"].as_str());
        let Some(turn) = turn.filter(|id| !id.is_empty() && id.len() <= 256) else {
            if matches!(method,"turn/started" | "turn/completed") {self.unavailable("비동기 질문 작업 식별자를 확인할 수 없습니다.");}
            return;
        };
        match method {
            "turn/started" => { self.revision += 1; self.begin(turn, true); },
            "turn/completed" => { self.revision += 1; self.close(turn); },
            "item/completed" => {
                if self.closed.contains(turn) || self.current_closed || self.turn.as_deref().is_some_and(|current| current != turn) { return; }
                if self.turn.is_none() { self.begin(turn, false); }
                let item=&params["item"];
                let relevant=(item["type"]=="agentMessage" && item["delivery"]=="async" && !item["questions"].is_null())
                    || (item["type"]=="userMessage" && item["content"].as_array().is_some_and(|content|content.iter().any(|input|input["type"]=="text" && input["text"].as_str().is_some_and(|text|text.contains(OPEN)))));
                if relevant {
                    self.revision += 1;
                    if let Err(error) = self.item(turn, &params["item"]) { self.unavailable(&error); }
                }
            },
            _ => {},
        }
    }
    fn item(&mut self, turn: &str, item: &Value) -> Result<(), String> {
        if item["type"] == "userMessage" { return self.resolve(item); }
        if item["type"] != "agentMessage" || item["delivery"] != "async" || item["questions"].is_null() { return Ok(()); }
        let call = item["id"].as_str().filter(|id| !id.is_empty() && id.len() <= 256).ok_or("비동기 질문 식별자가 올바르지 않습니다.")?;
        if self.seen.contains(call) { return Ok(()); }
        let questions = item["questions"].as_array().filter(|questions| !questions.is_empty() && questions.len() <= MAX_QUESTIONS).ok_or("비동기 질문 개수 또는 형식이 상한을 넘었습니다.")?;
        if self.pending.len() + questions.len() > MAX_QUESTIONS || self.seen.len() >= MAX_IDENTITIES { return Err("비동기 질문 관측 상한에 도달했습니다. 마지막 확인 내용을 보존했습니다.".into()); }
        let mut additions = Vec::new();
        for (index, question) in questions.iter().enumerate() {
            let title = question["title"].as_str().filter(|title| !title.trim().is_empty() && title.len() <= 16 * 1024).ok_or("비동기 질문 원문 형식 또는 크기가 올바르지 않습니다.")?;
            let options = if question["options"].is_null() { Vec::new() } else {
                question["options"].as_array().filter(|options| !options.is_empty() && options.len() <= 32).ok_or("비동기 질문 선택지 개수가 상한을 넘었습니다.")?.iter().map(|option| {
                    option.as_str().filter(|label| !label.trim().is_empty() && label.len() <= 512).map(|label| json!({"label":label})).ok_or("비동기 질문 선택지 형식 또는 크기가 올바르지 않습니다.")
                }).collect::<Result<Vec<_>,_>>()?
            };
            let id = json!(["request_user_input_async", call, index]).to_string();
            if id.len() > 512 { return Err("비동기 질문의 안정 식별자가 상한을 넘었습니다.".into()); }
            if self.answered.contains(&id) || self.answered.contains(call) { continue; }
            additions.push((id.clone(),json!({"method":"opendiy/asyncQuestion","requestId":id,"source":"async","turnId":turn,"questionItemId":id,"params":{"questions":[{"id":id,"question":title,"options":options,"isOther":true}]},"responded":false})));
        }
        self.seen.insert(call.into());
        self.pending.extend(additions);
        Ok(())
    }
    fn resolve(&mut self, item: &Value) -> Result<(), String> {
        let Some(content) = item["content"].as_array() else { return Ok(()); };
        let relevant = content.iter().filter(|input| !matches!(input["type"].as_str(), Some("skill" | "mention"))).collect::<Vec<_>>();
        if relevant.len() != 1 || relevant[0]["type"] != "text" { return Ok(()); }
        let Some(text) = relevant[0]["text"].as_str().filter(|text| text.len() <= 64 * 1024) else { return Ok(()); };
        let mut text = text.trim();
        if text.starts_with("# Context from my IDE setup:\n") {
            let Some((_, request)) = text.rsplit_once("\n## My request for Codex:\n") else { return Ok(()); };
            text = request.trim();
        }
        let Some(body) = text.strip_prefix(OPEN).and_then(|text| text.strip_suffix(CLOSE)) else { return Ok(()); };
        let Ok(replies) = serde_json::from_str::<Value>(body) else { return Ok(()); };
        let replies = match &replies { Value::Array(values) => values.clone(), Value::Object(_) => vec![replies], _ => return Ok(()) };
        if replies.is_empty() || replies.len() > MAX_QUESTIONS || replies.iter().any(|reply| reply["questionItemId"].as_str().is_none_or(|id| id.len() > 512) || !reply["answer"].is_string() || !reply["question"].is_string()) { return Ok(()); }
        for reply in replies {
            let id = reply["questionItemId"].as_str().unwrap();
            if self.answered.len() >= MAX_IDENTITIES && !self.answered.contains(id) { return Err("비동기 질문 해결 기록 상한에 도달했습니다.".into()); }
            self.answered.insert(id.into());
            self.pending.retain(|key,_| key != id && serde_json::from_str::<Value>(key).ok().is_none_or(|parts| parts[1].as_str() != Some(id)));
        }
        Ok(())
    }
    pub(super) fn restore(&mut self, revision: u64, turn: Option<&str>, entries: &[Value]) -> Result<bool, String> {
        if self.revision != revision { self.unavailable("질문 이력 조회 중 작업 상태가 바뀌었습니다. 실시간 관측 내용을 보존했습니다."); return Ok(false); }
        let Some(turn) = turn else { self.idle(); return Ok(true); };
        if self.closed.contains(turn) || (self.turn.as_deref()==Some(turn) && self.current_closed) { return Ok(true); }
        let mut restored = Self { closed: self.closed.clone(), revision, ..Self::default() };
        restored.begin(turn, true);
        for entry in entries {
            let result=history_item(entry,turn).and_then(|item|restored.item(turn,item));
            if let Err(error)=result {self.unavailable(&error);return Err(error);}
        }
        // A pending send is an at-most-once attempt, not a resolved answer.
        for (id, request) in &mut restored.pending {
            if self.pending.get(id).is_some_and(|old| old["responded"] == true) { request["responded"] = json!(true); }
        }
        *self = restored;
        Ok(true)
    }
    pub(super) fn reply_payload(&self, id: &str, result: &Value) -> Result<(String, String), String> {
        if !self.complete { return Err("비동기 질문의 현재 상태를 확인하지 못해 답변을 보내지 않았습니다.".into()); }
        let request = self.pending.get(id).ok_or("이미 해결되었거나 현재 작업에 속하지 않은 질문입니다.")?;
        if request["turnId"].as_str()!=self.active_turn_id() {return Err("현재 작업에 속하지 않은 질문입니다.".into());}
        if request["responded"] == true { return Err("이미 전송을 시도한 답변입니다. 다시 보내지 않았습니다.".into()); }
        if !result.as_object().is_some_and(|object|object.len()==1) {return Err("비동기 질문 답변 필드만 지정하세요.".into());}
        let answers = result["answers"].as_object().filter(|answers| answers.len() == 1).ok_or("비동기 질문 한 개의 답변만 지정하세요.")?;
        let values = answers.get(id).and_then(|value| value["answers"].as_array()).filter(|values| values.len() == 1).ok_or("비동기 질문의 안정 식별자와 답변을 확인하세요.")?;
        let answer = values[0].as_str().filter(|answer| !answer.trim().is_empty() && answer.len() <= 16 * 1024).ok_or("답변 원문 형식 또는 크기가 올바르지 않습니다.")?;
        let question = request["params"]["questions"][0]["question"].as_str().unwrap();
        let mut end = question.len().min(512); while !question.is_char_boundary(end) { end -= 1; }
        let question = question[..end].replace(['\r','\n'], " ");
        let text = format!("{OPEN}\n{}\n{CLOSE}", json!([{"answer":answer,"question":question,"questionItemId":id}]));
        let turn = request["turnId"].as_str().unwrap().to_owned();
        Ok((turn,text))
    }
    pub(super) fn prepare_reply(&mut self, id: &str, result: &Value) -> Result<(String, String), String> {
        let payload=self.reply_payload(id,result)?;
        self.pending.get_mut(id).unwrap()["responded"]=json!(true);
        Ok(payload)
    }
    pub(super) fn reply_attempt_current(&self,id: &str,turn: &str) -> bool {
        self.complete && self.active_turn_id()==Some(turn)
            && self.pending.get(id).is_some_and(|request|request["turnId"]==turn && request["responded"]==true)
    }
}

// ThreadItemsListResponse.data contains ThreadItemEntry envelopes, not raw
// ThreadItem payloads. Validate irrelevant items too, before replacing state.
fn history_item<'a>(entry: &'a Value, turn: &str) -> Result<&'a Value,String> {
    if !entry.is_object() || entry["turnId"].as_str()!=Some(turn) {
        return Err("질문 이력 항목이 요청한 작업에 속하는지 확인할 수 없습니다.".into());
    }
    let item=&entry["item"];
    if !item.is_object() || !item["id"].as_str().is_some_and(|id|!id.is_empty() && id.len()<=256 && !id.chars().any(char::is_control)) {
        return Err("질문 이력의 내부 항목 또는 식별자 형식이 올바르지 않습니다.".into());
    }
    match item["type"].as_str() {
        Some("agentMessage") if item["text"].is_string()=>{},
        Some("userMessage") if item["content"].as_array().is_some_and(|content|content.iter().all(|input|input.is_object() && input["type"].is_string() && (input["type"]!="text" || input["text"].is_string())))=>{},
        Some("hookPrompt" | "functionCallOutput" | "plan" | "reasoning" | "commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall" | "collabAgentToolCall" | "subAgentActivity" | "webSearch" | "imageView" | "sleep" | "imageGeneration" | "enteredReviewMode" | "exitedReviewMode" | "contextCompaction")=>{},
        _=>return Err("질문 이력의 내부 항목 유형 또는 필수 원문 형식이 올바르지 않습니다.".into()),
    }
    Ok(item)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn item() -> Value { json!({"type":"agentMessage","id":"call-1","text":"첫 질문\n다음 질문","delivery":"async","questions":[{"title":"첫 질문","options":["A","B"]},{"title":"다음 질문","options":null}]}) }
    fn entry(item: Value) -> Value {json!({"turnId":"turn-1","item":item,"startedAtMs":null,"completedAtMs":null})}
    fn params(item: Value) -> Value { json!({"turnId":"turn-1","item":item}) }
    fn started(state: &mut State) { state.observe("turn/started",&json!({"turn":{"id":"turn-1"}})); }
    fn reply(id: &str) -> Value { json!({"type":"userMessage","id":"user-answer","content":[{"type":"text","text":format!("{OPEN}\n{}\n{CLOSE}",json!([{"questionItemId":id,"question":"첫 질문","answer":"A"}]))}]}) }
    #[test]
    fn live_async_questions_preserve_identity_and_deduplicate() {
        let mut state=State::default(); started(&mut state);
        state.observe("item/started",&params(item())); assert!(state.snapshot(true).is_empty());
        state.observe("item/completed",&params(item())); state.observe("item/completed",&params(item()));
        let snapshot=state.snapshot(true); assert_eq!(snapshot.len(),2);
        assert_eq!(snapshot[0]["requestId"],r#"["request_user_input_async","call-1",0]"#);
        assert_eq!(snapshot[0]["params"]["questions"][0]["question"],"첫 질문");
        assert_eq!(snapshot[0]["params"]["questions"][0]["options"][1]["label"],"B");
    }
    #[test]
    fn user_answer_before_or_after_question_prevents_replay() {
        for answer_first in [false,true] {
            let mut state=State::default(); started(&mut state);
            let id=r#"["request_user_input_async","call-1",0]"#;
            if answer_first { state.observe("item/completed",&params(reply(id))); }
            state.observe("item/completed",&params(item()));
            state.observe("item/completed",&params(reply(id))); state.observe("item/completed",&params(item()));
            assert_eq!(state.snapshot(true).len(),1);
            assert_eq!(state.snapshot(true)[0]["requestId"],r#"["request_user_input_async","call-1",1]"#);
        }
    }
    #[test]
    fn completed_turn_cannot_reopen_or_clear_new_turn() {
        let mut state=State::default(); started(&mut state); state.observe("item/completed",&params(item()));
        state.observe("turn/completed",&json!({"turn":{"id":"turn-1"}}));
        state.observe("item/completed",&params(item())); assert!(state.snapshot(true).is_empty());
        state.observe("turn/started",&json!({"turn":{"id":"turn-2"}}));
        state.observe("item/completed",&json!({"turnId":"turn-2","item":item()}));
        state.observe("turn/completed",&json!({"turn":{"id":"turn-1"}})); assert_eq!(state.snapshot(true).len(),2);
        assert!(State::default().snapshot(true).is_empty()); assert!(!State::default().complete());
    }
    #[test]
    fn restore_failure_and_live_race_preserve_last_metadata() {
        let mut state=State::default(); state.restore(0,Some("turn-1"),&[entry(item())]).unwrap();
        assert!(state.complete()); state.unavailable("lookup failed"); assert_eq!(state.snapshot(true).len(),2);
        assert_eq!(state.snapshot(true)[0]["metadataAvailable"],true);
        assert_eq!(state.snapshot(false)[0]["metadataAvailable"],false);
        state.observe("item/completed",&params(reply(r#"["request_user_input_async","call-1",0]"#)));
        state.restore(0,Some("turn-1"),&[entry(item())]).unwrap(); assert_eq!(state.snapshot(true).len(),1); assert!(!state.complete());
    }
    #[test]
    fn bounds_are_explicit_and_bad_envelopes_do_not_resolve() {
        let mut state=State::default(); started(&mut state); state.observe("item/completed",&params(item()));
        let bad=json!({"type":"userMessage","content":[{"type":"text","text":format!("quoted {}",reply("call-1")["content"][0]["text"].as_str().unwrap())}]});
        state.observe("item/completed",&params(bad)); assert_eq!(state.snapshot(true).len(),2);
        let mut oversized=item(); oversized["id"]=json!("large"); oversized["questions"]=json!([{ "title":"x".repeat(16385) }]);
        state.observe("item/completed",&params(oversized)); assert!(!state.complete()); assert!(state.diagnostic().is_some()); assert_eq!(state.snapshot(true).len(),2);
    }
    #[test]
    fn answer_attempt_is_not_resolution_and_cannot_be_resent() {
        let mut state=State::default(); started(&mut state); state.observe("item/completed",&params(item()));
        let id=r#"["request_user_input_async","call-1",0]"#;
        let result=json!({"answers":{id:{"answers":["A"]}}});
        let (turn,text)=state.prepare_reply(id,&result).unwrap(); assert_eq!(turn,"turn-1");
        assert!(text.starts_with(OPEN)); assert!(text.contains("questionItemId")); assert_eq!(state.snapshot(true).len(),2);
        assert!(state.prepare_reply(id,&result).is_err());
        state.observe("item/completed",&params(reply(id))); assert_eq!(state.snapshot(true).len(),1);
    }
    #[test]
    fn history_entry_envelopes_restore_questions_and_answers_instead_of_false_empty() {
        let mut state=State::default();
        let id=r#"["request_user_input_async","call-1",0]"#;
        assert!(state.restore(0,Some("turn-1"),&[entry(reply(id)),entry(item()),entry(json!({"type":"contextCompaction","id":"unrelated"}))]).unwrap());
        assert!(state.complete());assert_eq!(state.snapshot(true).len(),1);
        assert_eq!(state.snapshot(true)[0]["requestId"],r#"["request_user_input_async","call-1",1]"#);
        assert_eq!(state.snapshot(true)[0]["params"]["questions"][0]["question"],"다음 질문");
    }
    #[test]
    fn r36_tuple_variants_preserve_pending_questions_in_complete_history() {
        let variants=vec![
            json!({"type":"webSearch","id":"search-1","query":"fixture query","action":{"type":"search","query":"fixture query","queries":null},"results":[]}),
            json!({"type":"sleep","id":"sleep-1","durationMs":1000}),
            json!({"type":"imageGeneration","id":"image-1","status":"completed","revisedPrompt":null,"result":"fixture-image","transparentBackground":false,"failure":null,"generationId":null}),
        ];
        let mut groups=variants.iter().map(|item|vec![item.clone()]).collect::<Vec<_>>();groups.push(variants);
        for group in groups {
            let mut state=State::default();let mut entries=vec![entry(item())];entries.extend(group.into_iter().map(entry));
            assert!(state.restore(0,Some("turn-1"),&entries).unwrap(),"normal R36 item must not make question metadata incomplete");
            assert!(state.complete());assert!(state.diagnostic().is_none());assert_eq!(state.snapshot(true).len(),2);
            assert_eq!(state.snapshot(true)[0]["requestId"],r#"["request_user_input_async","call-1",0]"#);
            assert_eq!(state.snapshot(true)[1]["params"]["questions"][0]["question"],"다음 질문");
        }
    }
    #[test]
    fn malformed_history_entries_fail_without_replacing_previous_questions() {
        let mut wrong_turn=entry(item());wrong_turn["turnId"]=json!("other-turn");
        let mut malformed=vec![wrong_turn,json!({"item":item()}),json!({"turnId":"turn-1"}),entry(Value::Null),entry(json!(3)),item()];
        for bad in [json!({"id":"invalid-type"}),json!({"id":"invalid-type","type":3}),json!({"id":"invalid-type","type":"unknownFutureItem"}),json!({"type":"reasoning"}),json!({"type":"reasoning","id":3}),json!({"type":"reasoning","id":""}),json!({"type":"reasoning","id":"x".repeat(257)}),json!({"type":"reasoning","id":"has\ncontrol"}),json!({"type":"agentMessage","id":"no-text","delivery":"async","questions":[]}),json!({"type":"userMessage","id":"no-content"})] {
            malformed.push(entry(bad));
        }
        for bad in malformed {
            let mut state=State::default();started(&mut state);state.observe("item/completed",&params(item()));
            let previous=state.snapshot(true);
            assert!(state.restore(state.revision,Some("turn-1"),&[entry(json!({"type":"contextCompaction","id":"valid-first"})),bad.clone()]).is_err(),"bad entry accepted: {bad}");
            assert!(!state.complete());assert!(state.diagnostic().is_some());
            let pending=state.snapshot(true);assert_eq!(pending.len(),2);
            assert_eq!(pending[0]["requestId"],previous[0]["requestId"]);assert_eq!(pending[1]["params"],previous[1]["params"]);
        }
    }
    #[test]
    fn saturated_closed_ids_do_not_reopen_the_current_completed_turn() {
        let mut state=State::default();
        for index in 0..MAX_IDENTITIES {
            let turn=format!("closed-{index}");state.observe("turn/started",&json!({"turn":{"id":turn}}));state.observe("turn/completed",&json!({"turn":{"id":turn}}));
        }
        assert_eq!(state.closed.len(),MAX_IDENTITIES);
        started(&mut state);state.observe("item/completed",&params(item()));assert_eq!(state.snapshot(true).len(),2);
        state.observe("turn/completed",&json!({"turn":{"id":"turn-1"}}));
        state.observe("item/completed",&params(item()));
        assert!(state.snapshot(true).is_empty(),"late completed-turn item must not return after tombstone saturation");
        state.observe("turn/started",&json!({"turn":{"id":"turn-1"}}));state.observe("item/completed",&params(item()));
        assert!(state.snapshot(true).is_empty());assert!(state.complete());assert!(state.diagnostic().is_none());
        assert!(state.restore(state.revision,Some("turn-1"),&[entry(item())]).unwrap());assert!(state.snapshot(true).is_empty());
        state.observe("turn/started",&json!({"turn":{"id":"new-turn"}}));state.observe("item/completed",&json!({"turnId":"new-turn","item":item()}));
        state.observe("turn/completed",&json!({"turn":{"id":"turn-1"}}));state.observe("item/completed",&params(item()));
        assert_eq!(state.snapshot(true).len(),2);assert!(state.complete());assert_eq!(state.closed.len(),MAX_IDENTITIES);
    }
    #[test]
    fn authoritative_current_completion_recovers_unknown_while_other_completion_preserves_it() {
        for saturated in [false,true] {
            let mut state=State::default();
            if saturated {for index in 0..MAX_IDENTITIES {let turn=format!("old-{index}");state.observe("turn/started",&json!({"turn":{"id":turn}}));state.observe("turn/completed",&json!({"turn":{"id":turn}}));}}
            started(&mut state);state.observe("item/completed",&params(item()));state.unavailable("history lookup failed");
            state.observe("turn/completed",&json!({"turn":{"id":"unrelated-old-turn"}}));
            assert!(!state.complete());assert_eq!(state.diagnostic(),Some("history lookup failed"));assert_eq!(state.snapshot(true).len(),2);
            state.observe("turn/completed",&json!({"turn":{"id":"turn-1"}}));
            assert!(state.complete());assert!(state.diagnostic().is_none());assert!(state.snapshot(true).is_empty());
            state.observe("item/completed",&params(item()));assert!(state.snapshot(true).is_empty());
        }
    }
}
