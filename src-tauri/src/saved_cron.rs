//! Desktop-owned definitions. Execution remains in the CLI lifetime scheduler.
use super::Store;
use crate::codex::{CronRequest, CronSchedule};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};

const PREFIX: &str = "saved_cron:";
const LIMIT: usize = 256;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedCron {
    pub id: String,
    pub thread_id: String,
    pub prompt: String,
    pub schedule: CronSchedule,
    pub registration: Option<Registration>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Registration {
    pub session_id: String,
    pub generation: u64,
    pub request_id: String,
    pub job_id: Option<String>,
    pub state: RegistrationState,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum RegistrationState { Pending, Registered, Unknown, Reconciled }

fn uuid(value: &str) -> Result<(), String> {
    if !uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value) { return Err("저장 예약 식별자가 올바르지 않습니다.".into()); }
    Ok(())
}

impl SavedCron {
    pub fn validate(&self) -> Result<(), String> {
        uuid(&self.id)?; uuid(&self.thread_id)?;
        if self.prompt.trim().is_empty() || self.prompt.contains('\0') || self.prompt.len() > 64 * 1024 { return Err("저장할 작업은 비어 있지 않은 64 KiB 이하 텍스트여야 합니다.".into()); }
        let value = match self.schedule { CronSchedule::Every { seconds } => seconds, CronSchedule::At { at_unix_ms } => at_unix_ms };
        if !(1..=9_007_199_254_740_991).contains(&value) { return Err("저장 예약 일정이 올바르지 않습니다.".into()); }
        if let Some(receipt) = &self.registration {
            uuid(&receipt.session_id)?; uuid(&receipt.request_id)?;
            if receipt.generation == 0 || receipt.job_id.as_ref().is_some_and(|id| !id.parse::<u64>().is_ok_and(|number| number > 0 && number.to_string() == *id)) { return Err("저장 예약의 등록 추적 정보가 올바르지 않습니다.".into()); }
        }
        Ok(())
    }
    pub fn request(&self, request_id: String) -> CronRequest {
        CronRequest::Add { request_id, schedule: self.schedule.clone(), prompt: self.prompt.clone() }
    }
}

impl Store {
    pub fn saved_crons(&self, thread_id: &str) -> Result<Vec<SavedCron>, String> {
        uuid(thread_id)?;
        let mut statement = self.connection.prepare("SELECT key,value FROM app_settings WHERE key GLOB 'saved_cron:*' AND json_extract(value,'$.threadId')=?1 ORDER BY key LIMIT 257").map_err(|e| format!("저장 예약 목록 준비: {e}"))?;
        let rows = statement.query_map([thread_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map_err(|e| format!("저장 예약 목록 조회: {e}"))?;
        let mut definitions = Vec::new();
        for row in rows {
            let (key, value) = row.map_err(|e| format!("저장 예약 읽기: {e}"))?;
            let definition: SavedCron = serde_json::from_str(&value).map_err(|_| "저장 예약 데이터 형식이 올바르지 않습니다.")?;
            definition.validate()?;
            if key != format!("{PREFIX}{}", definition.id) || definition.thread_id != thread_id { return Err("저장 예약의 소유 대화가 일치하지 않습니다.".into()); }
            definitions.push(definition);
        }
        if definitions.len() > LIMIT { return Err("저장 예약 목록의 상한을 초과했습니다.".into()); }
        Ok(definitions)
    }

    pub fn saved_cron(&self, id: &str) -> Result<SavedCron, String> {
        uuid(id)?;
        let text: String = self.connection.query_row("SELECT value FROM app_settings WHERE key=?1", [format!("{PREFIX}{id}")], |row| row.get(0)).optional().map_err(|e| format!("저장 예약 조회: {e}"))?.ok_or("저장 예약을 찾지 못했습니다.")?;
        let definition: SavedCron = serde_json::from_str(&text).map_err(|_| "저장 예약 데이터 형식이 올바르지 않습니다.")?;
        definition.validate()?;
        if definition.id != id { return Err("저장 예약 식별자가 일치하지 않습니다.".into()); }
        Ok(definition)
    }

    pub fn save_cron(&self, definition: &SavedCron, create: bool) -> Result<(), String> {
        definition.validate()?;
        let transaction = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate).map_err(|e| format!("저장 예약 트랜잭션 시작: {e}"))?;
        if create {
            let count: usize = transaction.query_row("SELECT count(*) FROM app_settings WHERE key GLOB 'saved_cron:*'", [], |row| row.get(0)).map_err(|e| e.to_string())?;
            if count >= LIMIT { return Err("저장 예약은 최대 256개입니다. 불필요한 저장 정의를 삭제하세요.".into()); }
        }
        let text = serde_json::to_string(definition).map_err(|_| "저장 예약을 변환하지 못했습니다.")?;
        let sql = if create { "INSERT INTO app_settings(key,value) VALUES(?1,?2)" } else { "UPDATE app_settings SET value=?2 WHERE key=?1" };
        let changed = transaction.execute(sql, params![format!("{PREFIX}{}", definition.id), text]).map_err(|e| format!("저장 예약 쓰기: {e}"))?;
        if changed != 1 { return Err("저장 예약이 변경되어 다시 조회해야 합니다.".into()); }
        transaction.commit().map_err(|e| format!("저장 예약 커밋: {e}"))
    }

    pub fn delete_saved_cron(&self, id: &str) -> Result<(), String> {
        uuid(id)?;
        self.connection.execute("DELETE FROM app_settings WHERE key=?1", [format!("{PREFIX}{id}")]).map(|_| ()).map_err(|e| format!("저장 예약 삭제: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn definition() -> SavedCron {
        SavedCron { id: uuid::Uuid::new_v4().to_string(), thread_id: uuid::Uuid::new_v4().to_string(), prompt: "  원문\n🐈 둘째 줄  ".into(), schedule: CronSchedule::Every { seconds: 300 }, registration: None }
    }
    #[test]
    fn saved_definition_reopens_exactly_and_preserves_other_settings() {
        let path = std::env::temp_dir().join(format!("saved-cron-{}.sqlite", uuid::Uuid::new_v4()));
        let mut value = definition();
        {
            let store = Store::open(&path).unwrap();
            store.set_ui_language(crate::ui_language::UiLanguage::En).unwrap();
            value.registration = Some(Registration { session_id: uuid::Uuid::new_v4().to_string(), generation: 4, request_id: uuid::Uuid::new_v4().to_string(), job_id: None, state: RegistrationState::Pending });
            store.save_cron(&value, true).unwrap();
        }
        let store = Store::open(&path).unwrap();
        assert_eq!(serde_json::to_value(store.saved_crons(&value.thread_id).unwrap()).unwrap(), serde_json::json!([value]));
        assert_eq!(store.ui_language().unwrap(), crate::ui_language::UiLanguage::En);
        assert!(store.saved_crons(&uuid::Uuid::new_v4().to_string()).unwrap().is_empty());
        drop(store);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn failed_definition_write_does_not_replace_existing_data() {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let value = definition(); store.save_cron(&value, true).unwrap();
        let mut invalid = value.clone(); invalid.prompt = "가".repeat(21846);
        assert!(store.save_cron(&invalid, false).is_err());
        assert!(store.save_cron(&value, true).is_err());
        assert_eq!(store.saved_cron(&value.id).unwrap().prompt, value.prompt);
        store.delete_saved_cron(&value.id).unwrap();
        assert!(store.saved_crons(&value.thread_id).unwrap().is_empty());
    }
}
