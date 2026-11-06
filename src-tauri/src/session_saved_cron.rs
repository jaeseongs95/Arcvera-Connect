use super::*;
use crate::storage::{Registration, RegistrationState, SavedCron};

impl Engine {
    fn cron_owner_alive(&self, receipt: &Registration) -> Result<bool, String> {
        let Some(session) = self.inner.sessions.lock().map_err(|_| "예약 세션 목록 상태 오류")?.get(&receipt.session_id).cloned() else { return Ok(false); };
        let info = session.info()?;
        Ok(info.generation == receipt.generation && session.phase.load(Ordering::Acquire) < 3)
    }

    pub fn saved_cron_list(&self, thread_id: &str) -> Result<Vec<SavedCron>, String> {
        // Never hold the store while acquiring session locks (session events save metadata).
        let definitions = self.inner.store.lock().map_err(|_| "예약 저장소 상태 오류")?.saved_crons(thread_id)?;
        for definition in &definitions {
            if let Some(receipt) = &definition.registration {
                if !self.cron_owner_alive(receipt)? {
                    let store = self.inner.store.lock().map_err(|_| "예약 저장소 상태 오류")?;
                    let mut current = store.saved_cron(&definition.id)?;
                    if current.registration.as_ref().is_some_and(|r| r.request_id == receipt.request_id) {
                        current.registration = None; store.save_cron(&current, false)?;
                    }
                }
            }
        }
        self.inner.store.lock().map_err(|_| "예약 저장소 상태 오류")?.saved_crons(thread_id)
    }

    pub fn saved_cron_save(&self, id: Option<String>, thread_id: String, prompt: String, schedule: codex::CronSchedule) -> Result<SavedCron, String> {
        if self.inner.exiting.load(Ordering::Acquire) { return Err("앱이 종료 중입니다.".into()); }
        let create = id.is_none();
        let definition = SavedCron { id: id.unwrap_or_else(|| Uuid::new_v4().to_string()), thread_id, prompt, schedule, registration: None };
        definition.validate()?;
        // A past one-time definition may be read, but a new/edited schedule must be future.
        definition.request(Uuid::new_v4().to_string()).validate()?;
        self.saved_cron_list(&definition.thread_id)?;
        let store = self.inner.store.lock().map_err(|_| "예약 저장소 상태 오류")?;
        if !create {
            let previous = store.saved_cron(&definition.id)?;
            if previous.thread_id != definition.thread_id { return Err("저장 예약의 원래 대화를 바꿀 수 없습니다.".into()); }
            if previous.registration.is_some() { return Err("이 CLI에 등록됐거나 결과 미확인인 정의는 수정할 수 없습니다. 먼저 CLI 예약을 삭제하고 새로고침하세요.".into()); }
        }
        store.save_cron(&definition, create)?;
        Ok(definition)
    }

    pub fn saved_cron_delete(&self, id: &str, thread_id: &str) -> Result<(), String> {
        if self.inner.exiting.load(Ordering::Acquire) { return Err("앱이 종료 중입니다.".into()); }
        self.saved_cron_list(thread_id)?;
        let store = self.inner.store.lock().map_err(|_| "예약 저장소 상태 오류")?;
        let definition = store.saved_cron(id)?;
        if definition.thread_id != thread_id { return Err("저장 예약의 원래 대화가 일치하지 않습니다.".into()); }
        if definition.registration.as_ref().is_some_and(|r| r.state != RegistrationState::Registered) { return Err("등록 결과 미확인인 저장 정의는 삭제할 수 없습니다. 원래 CLI의 연결과 목록을 확인하세요.".into()); }
        store.delete_saved_cron(id)
    }

    pub fn saved_cron_register(&self, id: &str, generation: u64, definition_id: &str, thread_id: &str) -> Result<serde_json::Value, String> {
        self.register_saved_with(id, generation, definition_id, thread_id, |request| self.cron_request_for_thread(id, generation, request, Some(thread_id)))
    }

    fn register_saved_with(&self, id: &str, generation: u64, definition_id: &str, thread_id: &str, send: impl FnOnce(codex::CronRequest) -> Result<serde_json::Value, String>) -> Result<serde_json::Value, String> {
        let session = self.lookup(id, generation)?;
        if session.phase.load(Ordering::Acquire) != 1 || session.stop_requested.load(Ordering::Acquire) { return Err("같은 대화의 실행 중인 CLI에서만 수동 등록할 수 있습니다.".into()); }
        if session.info()?.thread_id.as_deref() != Some(thread_id) { return Err("저장 예약의 원래 대화와 실행 대상이 다릅니다.".into()); }
        self.saved_cron_list(thread_id)?;
        let request_id = Uuid::new_v4().to_string();
        let request = {
            let store = self.inner.store.lock().map_err(|_| "예약 저장소 상태 오류")?;
            let mut definition = store.saved_cron(definition_id)?;
            if definition.thread_id != thread_id { return Err("저장 예약의 원래 대화와 실행 대상이 다릅니다.".into()); }
            if definition.registration.is_some() { return Err("이미 등록됐거나 결과 미확인인 예약입니다. 자동 재전송하지 않습니다.".into()); }
            let request = definition.request(request_id.clone()); request.validate()?;
            definition.registration = Some(Registration { session_id: id.into(), generation, request_id: request_id.clone(), job_id: None, state: RegistrationState::Pending });
            // Commit before sending. A crash leaves a blocking receipt, never a retryable blank.
            store.save_cron(&definition, false)?;
            request
        };
        let reply = send(request);
        let store = self.inner.store.lock().map_err(|_| "예약 저장소 상태 오류")?;
        let mut definition = store.saved_cron(definition_id)?;
        if let Some(receipt) = definition.registration.as_mut().filter(|r| r.request_id == request_id) {
            match reply.as_ref().ok().and_then(|value| value["status"].as_str()) {
                Some("notApplied" | "unsupported") => definition.registration = None,
                Some("applied") => {
                    receipt.job_id = reply.as_ref().ok().and_then(|value| value["jobId"].as_str()).map(str::to_owned);
                    receipt.state = RegistrationState::Registered;
                },
                _ => receipt.state = RegistrationState::Unknown,
            }
            store.save_cron(&definition, false)?;
        }
        let mut value = reply?;
        value["requestId"] = serde_json::json!(request_id);
        Ok(value)
    }

    pub(super) fn reconcile_saved_crons(&self, id: &str, generation: u64, thread_id: &str, snapshot: &serde_json::Value) -> Result<(), String> {
        if snapshot["supported"] != true || snapshot["connected"] != true { return Ok(()); }
        let store = self.inner.store.lock().map_err(|_| "예약 저장소 상태 오류")?;
        for mut definition in store.saved_crons(thread_id)? {
            let Some(receipt) = &definition.registration else { continue; };
            if receipt.session_id != id || receipt.generation != generation { continue; }
            // Reconcile acknowledgement has no add result/jobId. Never guess from promptPreview.
            if receipt.job_id.is_none() && receipt.state != RegistrationState::Registered && snapshot["mutationState"] == "clear" && snapshot["reconciledRequestId"].as_str() == Some(&receipt.request_id) {
                definition.registration.as_mut().unwrap().state = RegistrationState::Reconciled;
                store.save_cron(&definition, false)?;
            } else if let Some(job_id) = &receipt.job_id {
                let jobs = snapshot["jobs"].as_array().ok_or("예약 목록 형식 불일치")?;
                let job = jobs.iter().find(|job| job["id"].as_str() == Some(job_id));
                if job.is_some_and(|job| job["removed"] == true || (matches!(definition.schedule, codex::CronSchedule::At { .. }) && job["state"] == "finished")) || (job.is_none() && snapshot["hasMore"] == false) {
                    definition.registration = None; store.save_cron(&definition, false)?;
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> (Engine, Arc<Session>, SavedCron) {
        let engine = Engine::new(Path::new(":memory:"), Arc::new(|_| Ok(()))).unwrap();
        let thread = Uuid::new_v4().to_string();
        let session = engine.allocate(&StartRequest { cwd: std::env::current_dir().unwrap().to_string_lossy().into_owned(), title: "saved cron fixture".into(), project_id: None, project_assigned: false, thread_id: Some(thread.clone()), cols: 80, rows: 24 }).unwrap();
        session.phase.store(1, Ordering::Release);
        let definition = engine.saved_cron_save(None, thread, "  전체 원문\n🐈  ".into(), codex::CronSchedule::Every { seconds: 300 }).unwrap();
        (engine, session, definition)
    }
    #[test]
    fn saved_cron_reserves_before_send_and_blocks_duplicate_until_exact_job_removed() {
        let (engine, session, definition) = fixture(); let info = session.info().unwrap();
        let reply = engine.register_saved_with(&info.id, info.generation, &definition.id, &definition.thread_id, |request| {
            let current = engine.saved_cron_list(&definition.thread_id).unwrap();
            assert_eq!(current[0].registration.as_ref().unwrap().state, RegistrationState::Pending);
            assert!(engine.register_saved_with(&info.id, info.generation, &definition.id, &definition.thread_id, |_| panic!("duplicate sent")).is_err());
            let request = serde_json::to_value(request).unwrap();
            assert_eq!(request["prompt"], "  전체 원문\n🐈  "); assert_eq!(request["schedule"], json!({"type":"every","seconds":300}));
            Ok(json!({"status":"applied","jobId":"77"}))
        }).unwrap();
        assert_eq!(reply["status"], "applied");
        let snapshot = |jobs, more| json!({"supported":true,"connected":true,"hasMore":more,"jobs":jobs});
        engine.reconcile_saved_crons(&info.id, info.generation, &definition.thread_id, &snapshot(json!([]), true)).unwrap();
        assert!(engine.saved_cron_list(&definition.thread_id).unwrap()[0].registration.is_some(), "truncated list cannot prove absence");
        engine.reconcile_saved_crons(&info.id, info.generation, &definition.thread_id, &snapshot(json!([{"id":"77","removed":false}]), false)).unwrap();
        assert!(engine.saved_cron_delete(&definition.id, &Uuid::new_v4().to_string()).is_err());
        engine.reconcile_saved_crons(&info.id, info.generation, &definition.thread_id, &snapshot(json!([{"id":"77","removed":true}]), false)).unwrap();
        assert!(engine.saved_cron_list(&definition.thread_id).unwrap()[0].registration.is_none());
        session.finish("stopped").unwrap();
    }
    #[test]
    fn saved_cron_unknown_is_durable_and_reconcile_never_guesses_full_prompt_or_job() {
        let (engine, session, definition) = fixture(); let info = session.info().unwrap();
        assert!(engine.register_saved_with(&info.id, info.generation, &definition.id, &definition.thread_id, |_| Err("response lost".into())).is_err());
        let receipt = engine.saved_cron_list(&definition.thread_id).unwrap()[0].registration.clone().unwrap();
        assert_eq!(receipt.state, RegistrationState::Unknown);
        let snapshot = json!({"supported":true,"connected":true,"mutationState":"clear","reconciledRequestId":receipt.request_id,"hasMore":false,"jobs":[]});
        engine.reconcile_saved_crons(&info.id, info.generation, &definition.thread_id, &snapshot).unwrap();
        assert_eq!(engine.saved_cron_list(&definition.thread_id).unwrap()[0].registration.as_ref().unwrap().state, RegistrationState::Reconciled);
        assert!(engine.register_saved_with(&info.id, info.generation, &definition.id, &definition.thread_id, |_| panic!("unknown retried")).is_err());
        assert!(engine.saved_cron_delete(&definition.id, &definition.thread_id).is_err());
        session.finish("stopped").unwrap();
        assert!(engine.saved_cron_list(&definition.thread_id).unwrap()[0].registration.is_none());
    }
    #[test]
    fn saved_cron_rejects_other_thread_stale_generation_expired_time_and_keeps_definition() {
        let (engine, session, definition) = fixture(); let info = session.info().unwrap();
        assert!(engine.register_saved_with(&info.id, info.generation + 1, &definition.id, &definition.thread_id, |_| panic!("stale sent")).is_err());
        assert!(engine.register_saved_with(&info.id, info.generation, &definition.id, &Uuid::new_v4().to_string(), |_| panic!("wrong target sent")).is_err());
        let mut past = definition.clone(); past.schedule = codex::CronSchedule::At { at_unix_ms: 1 };
        engine.inner.store.lock().unwrap().save_cron(&past, false).unwrap();
        assert!(engine.register_saved_with(&info.id, info.generation, &past.id, &past.thread_id, |_| panic!("expired sent")).is_err());
        assert!(engine.saved_cron_list(&past.thread_id).unwrap()[0].registration.is_none());
        let updated = engine.saved_cron_save(Some(past.id.clone()), past.thread_id.clone(), past.prompt.clone(), codex::CronSchedule::Every { seconds: 600 }).unwrap();
        for status in ["notApplied", "unsupported"] {
            engine.register_saved_with(&info.id, info.generation, &updated.id, &updated.thread_id, |_| Ok(json!({"status":status}))).unwrap();
            assert!(engine.saved_cron_list(&updated.thread_id).unwrap()[0].registration.is_none());
        }
        engine.saved_cron_delete(&updated.id, &updated.thread_id).unwrap();
        assert!(engine.saved_cron_list(&updated.thread_id).unwrap().is_empty()); session.finish("stopped").unwrap();
    }
}
