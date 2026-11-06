# Hook 관리 사전 테스트케이스

대상: `feat/hooks-and-session-context`, 기준 `ffec9fc`.
공식 Codex CLI 0.166.0과 OpenDIY R36 실행 파일에서 생성한 실제 스키마에 `hooks/list`, `config/read`, `config/batchWrite` 및 같은 HookMetadata 필드가 있음을 확인했다. 스키마 생성은 실제 목록·변경 성공을 대신하지 않는다.

| ID | 입력·사전조건 | 기대 결과·통과 기준 |
| --- | --- | --- |
| HK01 | 선택 CLI와 선택 프로젝트, command/MCP/prompt/agent hook 응답 | 해당 문맥의 목록·이벤트·출처·실행 내용·활성·신뢰 상태 표시. CLI 문자열은 HTML로 실행하지 않음 |
| HK02 | 프로젝트/CLI 변경·닫기 뒤 이전 조회가 늦게 완료 | 이전 목록·검토 대상·변경 결과가 새 문맥에 적용되지 않음 |
| HK03 | 선택한 신뢰된 일반 hook의 활성/비활성 변경 | 정확한 key/hash를 재조회하고 user config의 그 hook 상태만 수정. 재조회된 실제 상태가 일치해야 성공 |
| HK04 | untrusted/modified hook을 검토해 신뢰 승인 | 현재 내용 hash만 승인하고 enabled를 암묵적으로 바꾸지 않음. 표시 이후 hash 변경·관리 hook은 쓰기 전 거부 |
| HK05 | 점·따옴표가 포함된 key, 중복 key, 잘못된 필드·과대 목록 | key는 고정 hooks.state의 JSON 객체 key로만 사용. 중복/비정상 응답 거부, 임의 RPC·경로 편집 불가 |
| HK06 | config 버전 충돌·정책 덮어쓰기·쓰기 후 hook 변경 | expectedVersion 충돌과 실제 상태 불일치를 성공으로 표시하지 않고 자동 재시도하지 않음 |
| HK07 | 미지원 method·연결 실패·부분 진단 | 미지원/실패를 빈 목록 성공으로 바꾸지 않음. 다른 플러그인·스킬 및 기본 대화 기능은 유지 |
| HK08 | 공식 CLI, 자체 HOME/프로젝트의 무해한 hook fixture | 실제 hooks/list·개별 on/off·신뢰 write/read-back 확인. 실제 사용자 설정과 인증은 열거나 변경하지 않음 |
| HK09 | R36 CLI, HK08과 같은 격리 fixture | 같은 관리 동작과 보존 경계 확인. 운영 daemon/발행 R36 파일은 변경하지 않음 |
| HK10 | 조회·변경 진행 중 창 닫기/앱 종료 | 기존 admission·종료 drain·오래된 응답 방어 유지, 소유한 자식 프로세스 정리 |
| HK11 | 관리 hook·검토하지 않은 hook·임의 요청 필드 | 관리 정책 우회 금지. 검토하지 않은 내용의 실행 승인·임의 config 편집을 만들지 않음 |
| HK12 | 실행 입력 본문이 메타데이터에 없는 MCP/prompt/agent handler | 이 앱에서 신뢰 승인은 제공·전송하지 않음. 조회·비활성 및 이미 신뢰된 항목의 사용 설정은 보존 |

기존 시험 runner와 실제 CLI를 재사용한다. 실제 hook 명령 실행, 외부 계정·네트워크 서비스, 사용자 HOME 변경은 시험 범위에서 제외한다. 실제 쓰기 시험은 자체 임시 HOME만 사용한다. 실행 결과는 PASS/FAIL/NOT_RUN/UNKNOWN으로 분리하고 mock 통과를 실제 CLI 연동 성공으로 보고하지 않는다.

## 실제 실행 근거

2026-11-04: 공식 0.166.0 및 설치 R36의 자체 HOME/stdin app-server 시험은 각각 assertion 11개 PASS, 정상 EOF 종료 0이었다. 목록·개별 on/off·opaque hash 승인·비활성 보존·타 설정 보존·실제 configVersionConflict·내용 변경 후 modified 상태를 확인했다. thread/turn/tool 요청과 운영 daemon 조작은 없었다.

원시 자료는 `D:/codex/build/odHooksSchema/hooks-runtime/attempt-03/{official,r36}/output/`의 report/requests/responses 및 runner-source에 보존한다. attempt-01의 프로젝트 신뢰 경로 오류와 attempt-02의 시험 oracle 오류도 실패 상태로 보존했다. 이 결과는 CLI 계약 검증이며 새 Rust 제품 코드·네이티브 GUI·모든 진행 thread 적용 확인을 대신하지 않는다. Rust 단위시험은 로컬 cargo 부재로 미실행이며 CI 확인이 필요하다.

독립 감사에서 R36 정본의 MCP 실행 입력은 hash와 실제 실행에 포함되지만 hooks/list에 없음을 확인했다. 현재 화면에서 전체 정의를 검토할 수 없는 MCP/prompt/agent의 새 신뢰 승인은 UI와 backend 양쪽에서 제공하지 않는다. command 신뢰, 조회, 비활성, 이미 신뢰한 MCP의 개별 on/off는 유지한다. 이 제한은 버전 이름 추정이 아니라 실제 메타데이터 계약에 따른다.

HK12 사전 Playwright 3사례는 수정 전 모두 FAIL(exit 1), 수정 후 기존 관리 사례와 합친 21개는 PASS(exit 0,39.2초)였다. 원본은 `artifacts/hooks-incomplete-definition-{red,green}`에 분리했다. hook Rust 시험은 13개로 보강했으며 최종 후보 CI에서 실제 실행을 확인해야 한다. 이 PC의 미실행을 통과로 바꾸지 않는다.
