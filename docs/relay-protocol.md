# OpenDIY Remote <-> OpenDIY Desktop Host Relay Protocol Specification (v1.0.0)

이 문서는 작업용 PC의 **OpenDIY Desktop(Host Connector)** 과 개인 VPS/Lightsail의 **OpenDIY Remote(`--mode relay`)** 간 1:1 보안 중계 프로토콜 정본 규격입니다.
참조 구현체는 [`server/remote-server.mjs`](../server/remote-server.mjs)에 위치합니다.

---

## 1. 전송 계층 및 URL 정규화 (`normalizeRelayBaseUrl`)

- **전송 방식 (v1.0.0 정본)**:
  - **HTTP/1.1 또는 HTTPS 기반 Server-Sent Events(`GET /api/relay/stream`) + JSON POST(`POST /api/relay/reply`, `POST /api/relay/event`, `POST /api/relay/disconnect`)** 를 사용합니다.
  - 별도 WebSocket(`Upgrade: websocket`) 프레임 변환은 사용하지 않습니다(리버스 프록시·방화벽 호환성 및 무상태 단순성 유지).
- **사용자 입력 URL 스킴 정규화 (`ws://` / `wss://` 허용)**:
  - 사용자가 CLI나 Desktop 연결 UI에 `wss://my-relay.example.com` 또는 `ws://127.0.0.1:3210` 형태로 입력하더라도 호스트 어댑터의 `normalizeRelayBaseUrl(rawUrl)`에서 아래와 같이 정규화하여 연결합니다.
    - `wss://...` → `https://...`
    - `ws://...` → `http://...`
    - 말미의 `/` 및 실수로 붙인 `/api/relay/*` 경로 접미사 제거, 쿼리스트링/해시 제거
    - `http:`, `https:`, `ws:`, `wss:` 외의 스킴은 즉시 오류로 거부

---

## 2. 인증 헤더 및 1인 1중계기 독점 잠금 (Single-Host Lock)

모든 `/api/relay/*` 요청에는 다음 HTTP 헤더를 포함해야 합니다.

| 헤더 이름 | 필수 여부 | 설명 |
| --- | --- | --- |
| `X-OpenDIY-Host-Secret` | 필수 (비밀키 설정 시) | 중계 서버의 `--host-secret` (또는 `OPENDIY_REMOTE_HOST_SECRET`, 미지정 시 `--token`)과 일치해야 함. `Authorization: Bearer <secret>` 형식도 허용. SHA-256 `timingSafeEqual`로 검증하며, 60초 내 5회 실패 시 해당 IP를 5분간 `429 Too Many Requests`로 차단. |
| `X-OpenDIY-Host-Id` | 필수 | Desktop 호스트 연결 인스턴스를 식별하는 고유 UUID (재연결 시 동일 `hostId` 유지). |

### Single-Host Lock 동작
1. 활성 리스(`activeHostLease`)가 없거나, 기존 리스의 `hostId`와 동일한 `X-OpenDIY-Host-Id`가 `GET /api/relay/stream`을 요청하면 연결을 수락(`200 OK`, `Content-Type: text/event-stream; charset=utf-8`)하고 첫 SSE 데이터 프레임으로 다음을 전송합니다.
   ```
   data: {"type":"registered","hostId":"<hostId>","protocolVersion":"1.0.0"}

   ```
2. 다른 `hostId`가 이미 살아있는 스트림을 점유 중일 때 제3의 `hostId`가 접속을 시도하면 즉시 `409 Conflict`를 반환하고 거부합니다.
   ```json
   {
     "ok": false,
     "error": "이 중계기에는 이미 소유자의 로컬 PC 호스트 1대가 독점 연결되어 있습니다 (Single-Host Lock)."
   }
   ```
3. 중계 서버는 15초마다 `: keepalive\n\n` 주석 프레임을 스트림에 기록합니다.

---

## 3. 명령 Allowlist 및 민감 명령 차단 (`RELAY_COMMAND_ALLOWLIST` / `RELAY_BLOCKED_COMMANDS`)

원격 브라우저(`POST /api/invoke`)에서 들어온 명령은 중계 서버(`invokeRelayHost`)와 Desktop 호스트 어댑터 양쪽에서 모두 **`RELAY_COMMAND_ALLOWLIST`** 로 검증합니다.

### 3.1 허용 명령 (`RELAY_COMMAND_ALLOWLIST`, 총 50개)
- **언어/런타임 상태 조회·자동 업데이트 및 레이아웃**:
  - `get_ui_language`, `set_ui_language`
  - `prepare_runtime`, `get_codex_settings`, `runtime_compatibility`, `runtime_pair_status`, `runtime_transition_preview`
  - `check_for_updates`, `apply_update`
  - `load_layout`, `save_layout`, `weekly_usage`
- **프로젝트 관리**:
  - `list_projects`, `import_project`, `create_project`, `rename_project`, `set_project_favorite`, `delete_project`, `reorder_project`
- **세션·터미널·슬래시 명령 제어**:
  - `start_session`, `list_sessions`, `session_write`, `session_resize`, `session_stop`, `session_output_ack`, `move_session_to_project`, `list_external`, `slash_commands_list`
- **카탈로그 및 대화(Conversation) / 질문·승인함**:
  - `catalog_list`, `catalog_preview`
  - `conversation_request`
  - `list_pending_questions`, `respond_pending_question`
  - `choose_conversation_attachments`, `conversation_attachment_storage`, `stage_conversation_image`, `cleanup_conversation_attachment`
- **확장·서브에이전트·예약(Cron)·모바일 제어**:
  - `extensions_list`, `extensions_mutate`
  - `mobile_control`, `subagents_request`, `cron_request`, `saved_cron_list`, `saved_cron_save`, `saved_cron_delete`, `saved_cron_register`
- **원격 경로 탐색 및 지정 보조 명령 (네이티브 파일 대화상자 호출 금지)**:
  - `list_directory`, `choose_project_folder`, `choose_skill_folder`, `choose_project`
  - **중요 보안/동작 규칙**: 원격 브라우저는 `list_directory`로 호스트 디렉터리 목록을 조회한 뒤 `args.path` 또는 `args.cwd`로 문자열 경로를 직접 전달합니다. 호스트 어댑터는 전달받은 경로의 존재·디렉터리 여부만 검증해야 하며, **절대로 작업용 PC 화면에 OS 네이티브 파일 선택 창(모달 다이얼로그)을 띄워 스레드를 블로킹해서는 안 됩니다.** (`choose_conversation_attachments` 역시 `args.paths` 배열만 검증합니다.)

### 3.2 차단 명령 (`RELAY_BLOCKED_COMMANDS`, 원격 호출 금지)
다음 명령은 원격 브라우저가 로컬 Desktop 앱을 종료시키거나 임의 실행 파일로 런타임을 교체하는 것을 막기 위해 중계 대상에서 **엄격히 차단**합니다.
- `complete_exit`: 원격 브라우저가 로컬 PC의 Desktop 프로세스를 종료하는 행위 차단
- `unconfirmed_exit_available`: 중계 서버가 즉시 `false`를 반환하며 호스트로 전달하지 않음
- `set_codex_executable`, `set_app_server_executable`, `choose_codex_executable`, `choose_app_server_executable`, `apply_runtime_transition`: 원격에서 호스트 PC의 실행 파일 경로를 변경하거나 서버 바이너리를 교체하는 행위 차단
- `open_external_url`: 원격 브라우저 자신이 새 탭으로 열어야 하며, 호스트 PC에서 브라우저 창이 열리지 않도록 차단

### 3.3 민감 명령 승인/권한 확인 규칙
- `respond_pending_question` 및 `conversation_request` (`type: "respond"`):
  - 반드시 현재 살아있는 동일 세션(`sessionId`, `generation`)에 속하고 `canRespond === true` 상태인 미응답 `requestId`에 대해서만 1회 응답을 허용합니다.
- `mobile_control`:
  - 기존 Desktop의 세션 소유 검증(`id`, `generation`) 및 Codex 자체 `remoteControl/*` 계약을 그대로 따릅니다.

---

## 4. 이벤트 Allowlist (`RELAY_EVENT_ALLOWLIST`)

호스트가 `POST /api/relay/event`로 중계 서버에 전달할 수 있는 이벤트 이름은 아래 7개로 제한됩니다.

- `terminal-output`: 원시 터미널 출력 스트림 (`{ id, generation, seq, data }`)
- `session-output`: 세션 출력 스트림 (`{ id, generation, seq, data }`)
- `session-changed`: 세션 상태·메타데이터 변경 (`SessionInfo`)
- `host-connection-changed`: 호스트 연결 상태 변경 (`{ connected: boolean }`)
- `runtime-updated`: 런타임 상태 갱신 알림
- `update-available`: 새 릴리스 업데이트 감지 알림
- `update-status-changed`: 자동 업데이트 다운로드·적용 진행 상태 알림

Allowlist에 없는 이벤트 이름을 전송하면 중계 서버는 `400 Bad Request` (`{ "ok": false, "code": "EVENT_NOT_ALLOWED", "error": "..." }`)를 반환합니다.

---

## 5. 타임아웃·연결 해제 시 취소·재접속 및 중복 `reqId` 처리 규격

### 5.1 원격 명령 호출 흐름 (`invoke` -> `reply`)
1. 중계 서버는 원격 브라우저의 `POST /api/invoke` 수신 시 `reqId = crypto.randomUUID()`를 생성하고 `activeHostLease.pendingCalls`에 등록한 뒤 SSE 스트림(`GET /api/relay/stream`)으로 전송합니다.
   ```
   data: {"type":"invoke","reqId":"<uuid>","command":"<command>","args":{...}}

   ```
2. **타임아웃 (`RELAY_INVOKE_TIMEOUT_MS = 30000`, 30초)**:
   - 30초 내에 `POST /api/relay/reply`가 도착하지 않으면 중계 서버는 `pendingCalls`에서 `reqId`를 제거하고 원격 브라우저에 오류(`로컬 PC 호스트 응답 시간 초과 (<command>)`)를 반환합니다.
3. **결과 응답 (`POST /api/relay/reply`)**:
   - 성공 시: `{"reqId":"<uuid>","ok":true,"result":<value>}`
   - 실패 시: `{"reqId":"<uuid>","ok":false,"error":"<message>"}`

### 5.2 접속 해제 시 Pending Invoke 즉시 취소 (`releaseHostLease` & `POST /api/relay/disconnect`)
- 사용자가 Desktop UI에서 **「연결 해제」**를 누르면 호스트 어댑터는 다음 순서로 종료합니다:
  1. 새 재연결 타이머를 중단하고 진행 중인 `inFlightReqIds` 추적을 정리합니다.
  2. 열려 있는 SSE 스트림(`GET /api/relay/stream`)을 닫고 `POST /api/relay/disconnect` (헤더: `X-OpenDIY-Host-Id`, `X-OpenDIY-Host-Secret`)를 호출합니다.
- 중계 서버는 스트림 종료 또는 `POST /api/relay/disconnect` 수신 즉시:
  1. `activeHostLease.pendingCalls`에 남아 있는 **모든 미결(pending) 요청의 타이머를 해제하고 즉시 실패(`로컬 PC 호스트 연결이 끊어졌습니다.`)로 reject**합니다.
  2. `activeHostLease = null`로 비워 새 호스트 연결을 받을 수 있게 하고, 원격 브라우저들에 `host-connection-changed: { connected: false }`를 브로드캐스트합니다.

### 5.3 재접속 및 중복/지연 `reqId` 멱등성 처리
- **중계 서버 측 (`POST /api/relay/reply`)**:
  - 이미 타임아웃되었거나 처리 완료되어 `pendingCalls`에 없는 `reqId`에 대해 뒤늦은(또는 중복된) `reply`가 도착하면, 오류를 내지 않고 `200 OK` (`{"ok":true,"ignored":true}`)로 멱등 처리합니다.
- **Desktop 호스트 어댑터 측**:
  - `inFlightReqIds: Set<string>` 및 `completedReqIds: Map<string, { reqId, ok, result?, error? }>` (최대 256개 FIFO/LRU 유지)를 관리합니다.
  - 동일한 `reqId`가 `inFlightReqIds`에 있으면 중복 실행하지 않고 무시합니다.
  - 동일한 `reqId`가 `completedReqIds`에 있으면 명령을 재실행하지 않고 저장된 응답을 `POST /api/relay/reply`로 재전송합니다.
