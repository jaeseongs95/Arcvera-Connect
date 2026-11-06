# Native 시작 출력과 입력 활성화 사례

작성 시점: 구현 전. 대상 기준: `93f66e10cc1fe99166f1db84ec5cfc128116db6f`.
Native N1–N6 실행은 root의 Windows CI가 담당하며 아래 해당 상태는 `NOT_RUN`이다. Renderer N7은 로컬 Chromium의 실제 main/xterm 경계에서 실행했으며 결과를 따로 기록한다.

## 요구와 CS 조건

- R1 / CONC-LOCK-003: 준비 단계에서 사용자 입력은 거절한다. reader가 전달하는 출력은 같은 세대의 입력을 받을 수 있는 live 단계 이후에만 renderer에 보낸다.
- R2 / CONC-CANCEL-004: stop이 먼저 이기면 suspended child를 실행하지 않는다. worker 설치·resume 실패는 metadata 락을 해제한 뒤 기존 회수 경로로 정리한다.
- R3 / OS-LIFETIME-001: reader는 종료 시 계속 drain할 수 있어야 한다. metadata 락 안에서 `ClosePseudoConsole`, reader join, stop/rollback 대기를 호출하지 않는다. OS 카드는 실제 소유 PTY/child 회수 때문에 선택한 draft 규칙이다.
- R4: fixture 준비 표식 실패에 DSR 응답 실패의 세대·오류가 남는다. 기존 실패와 과거 성공 근거는 보존한다.

## 사전 시험 계획

| 사례 | 입력·전제 | 절차 | 기대 결과와 판정 | 실제 결과 |
| --- | --- | --- | --- | --- |
| N1 준비 입력 거절 | in-memory Engine, 설치된 실제 suspended PTY, phase=0 | 기존 post-install probe에서 `Engine.write`로 사용자 텍스트 입력 | `session is not live` 오류, child 미실행. 성공 입력이면 FAIL | NOT_RUN |
| N2 조기 DSR 전달 순서 | 같은 PTY, metadata guard 획득 직후·reader 설치 전 test-only probe, 조건제어 DSR 출력 | 실제 `Session.output`을 별도 스레드에서 호출하고 renderer가 실제 `Engine.write`로 CPR 응답. 이 경계에는 native reader가 없어 `try_lock`이 main의 락 보유 여부를 정확히 구분한다. 구구현은 락이 비어 있으면 probe 안에서 응답 완료까지 기다려 phase0 interleaving을 고정. 수정구현은 생산 output의 reserve 진입을 확인한 뒤 probe를 풀어 live 전환 허용 | controlled DSR의 전달 phase=1, CPR write 성공, preparing 입력 거절 유지. 자연 DSR 오류도 별도 보존하여 controlled assertion 뒤에 empty를 검사한다. 구구현은 phase0 CPR 거절로 FAIL, 수정은 PASS해야 함. 합성 DSR 주입은 production output/write 경계 검증이며 CI의 실제 DSR 발행 시점 자체를 증명하지 않음 | NOT_RUN; red/green root 담당 |
| N3 worker 실패 회수 | 실제 suspended PTY, 기존 `owned_worker::fail_once`, STARTUP-CR-001 보강은 구현 전 계획 | 기존 `launch_output_worker_install_failure_reaps_owned_child_and_drops_reader_capture`, `launch_reaper_worker_install_failure_reaps_owned_child_and_joins_live_reader` 실행. 실제 `OwnedChild::drop`의 kill/wait 직전에 test-only spy가 정확한 child PID와 metadata `try_lock` 가능 여부만 기록하고 실패 경로에서는 panic하지 않음 | 원래 child signal, Job active=0, started reader 전부 join 후 완료 한 번. 두 실패 모두 실제 child drop/wait 진입 시 metadata 락 획득 가능. 락 보유·timeout·reader 잔존이면 FAIL | NOT_RUN; STARTUP-CR-001은 재리뷰에서 발견된 별도 회수 결함이며 93f 원격 readiness 실패 원인으로 승격하지 않음 |
| N4 stop 선점 | post-install probe, phase0 | 기존 `launch_post_install_failure_publishes_unknown_once_after_owned_cleanup`와 prepare 중 stop 사례 실행 | probe는 metadata 락 밖에서 재진입 가능. 기존 최종 상태·같은 child 회수 조건 유지 | NOT_RUN |
| N5 DSR 오류 원인 보존 | headless collector가 preparing 세대의 CPR write 오류 관측 | DSR 오류를 수집한 뒤 같은 세대 readiness marker timeout 오류 검사 | 원래 marker·fixture tail·DSR write 원인이 모두 포함. 오류 누락이면 FAIL | NOT_RUN |
| N6 원래 native 경계 | 새 후보 실행 파일, 기존 native_pty 통합시험 | 변경 없는 8개 self-test, 두 fixture exact handle 종료 검사 | 8 PASS, fail=0, exact PID/생성시각 두 handle 모두 exitSignaled=true. 계측 누락은 PASS 불가 | NOT_RUN |
| N7a renderer Changed 순서 | 실제 main 부팅·xterm, generation7 starting 세션, `list_sessions` 응답 hold, `ESC[3;9H ESC[6n` 출력 seq1 | starting 동안 사용자 키·출력 주입, xterm parse barrier 확인 후 같은 세대 idle Changed 전달 | starting의 canType=false/disableStdin=true, 출력 parse·ACK·CPR 모두 보류. live Changed 뒤 실제 xterm이 정확히 `ESC[3;9R`을 generation7 native session_write로 1회 전달, parse 완료 뒤 ACK seq1. 늦은 list 응답에서 중복 없음 | PASS; 기준 함수 RED → 후보 GREEN |
| N7b renderer list 확인 순서 | N7a와 동일하되 Changed 없음 | held list snapshot만 idle로 바꾸고 응답 해제 | live list 확인 뒤 N7a와 같은 정확 CPR·ACK 1회. starting 사용자 키는 버리고 live 키는 기존 입력 정책에 따라 전달 | PASS; 기준 함수 RED → 후보 GREEN |
| N7c renderer 경계 보존 | generation7 starting 세션·held metadata, 오래된 generation6 출력·중복 seq·버퍼 초과 출력·동일 세대 stopped 전환 | 초기 버퍼 경계와 최종 stopped drain·ACK 관찰 | 오래된 세대는 렌더링·입력하지 않고 ACK, 시작 버퍼는 기존32세션/524288 data.length 상한 유지. overflow는 버리고 ACK+오류 표시. stopped는 입력 금지 유지하면서 buffered tail parse·ACK, CPR 전송 없음 | PASS; 기준 함수 RED → 후보 GREEN |
| N7d renderer 32키 상한 | starting 세션1개 + metadata 미확인31개로 pending key32개, 각 payload는 524288 이내 | 이미 pending에 있는 세션에 seq2 추가 후 33번째 새 키 출력 | 기존 세션의 seq1/seq2 보존, key 수32 유지. 33번째 새 키는 버리고 ACK+오류 표시. live·목록 확인 후 기존 프레임 parse·정리, seq2를 슬롯 초과로 버리면 FAIL | PASS; 기존 키 조건 RED → 후보 GREEN |

## 실행 명령과 근거 경계

기존 runner: `cargo test --locked --manifest-path src-tauri/Cargo.toml -- --nocapture`.
표적 red/green은 같은 신규 N2 test source·argv를 사용하고, 격리 사본에서 production lock 변경만 제거한 후보와 수정 후보를 비교한다. 원래 작업 트리를 reset하지 않는다. 실행 전 test file digest와 대상 commit을 보존한다.

기존 93f CI 실패: `artifacts/question-fix/93f-native-first.log`의 362 PASS/7 ignored 뒤 executable 7 PASS/1 FAIL, readiness 20초 미관측. `stop` 호출과 fixture PID handle 관측 전 실패다.
동일 93f CI 실행 파일의 로컬 결과: `artifacts/native-link-smoke/93f66e1/self-test-local.json`은 8 PASS, tree 2→5→2, exact 두 handle 종료. 과거 ee2 CI도 8 PASS다. 이 성공을 원격 실패 해결이나 새 후보 통과로 재분류하지 않는다.

## N7 renderer 범위와 사전 검증 방법

`ponytail`, `test-engineering`, `cs-engineering`을 적용한다. native가 live phase로 전환해도 Changed event보다 output event가 먼저 renderer에 도착할 수 있다. `canType`은 starting을 거절하며 xterm `disableStdin`은 사용자 키뿐 아니라 DSR protocol 응답도 차단한다. 따라서 starting 출력은 기존 orphan/startup pending 버퍼에 넣고 live metadata를 확인한 뒤 파싱한다. protocol 전용 채널이나 가시성·대화 owner 입력 정책은 추가하지 않는다.

기존 Playwright `tests/terminal-flow.spec.ts`의 native fixture를 재사용한다. 공개 xterm write/parse 완료·onData와 실제 main의 canType·pending/ACK 흐름을 관측하되 native transport만 stub한다. 먼저 기준 `93f66e1`의 원래 receiveOutput 함수를 Playwright route에 넣어 같은 N7 사례가 parser 보류 또는 CPR assertion으로 RED가 되는지 확인하고, 제품 후보에서 GREEN을 확인한다. 작업 트리는 reset하지 않는다. 신규 표적 사례와 관련 기존 output/세대 시험, frontend build만 실행한다. 실제 Windows native IPC·PTY의 DSR 타이밍 검증을 대신하지 않는다.

숨긴 프로젝트 또는 대화 owner 상태에서 `disableStdin`이 DSR도 막는 기존 정책은 별도 후속 검토 후보다. 이번 수정은 metadata 도착 순서만 다루며 그 정책을 바꾸거나 해결했다고 보고하지 않는다.

## N7 실제 실행 결과

- 기준 `93f66e1`의 `receiveOutput` 함수만 Playwright route에 주입한 격리 실행: `TERMINAL_STARTUP_BASELINE=1 npx playwright test tests/terminal-flow.spec.ts -g N7 --reporter=list`, **3 assertion FAIL / 종료1**. starting 상태인데 이미 parse·ACK됐고 CPR은 없었다. 소스 작업 트리를 되돌리지 않았다.
- 같은 3개 사례의 제품 후보: 같은 argv, baseline 환경값만 해제, **3 PASS / 종료0**. 두 실행의 test file SHA-256은 `58588214e367bba2d8894c84f95c9911b260ab1bcdd256faf0dafb1eed3f91c1`로 동일했다. 이후 N7d를 추가했다.
- 첫 시도 N7c는 구함수에서 pending이 없을 때 fixture가 TypeError를 냈다. 그 실행은 N7a/b의 유효 assertion FAIL과 구분해 `first-red-output.txt` 및 첫 trace에 보존했다. pending 없음은 빈 배열로 관측하도록 fixture를 고친 뒤 유효 assertion RED를 다시 실행했다. 큰 합성 payload가 실패 로그에 전부 찍히던 진단은 길이·최대80문자 prefix로 제한했으며 입력·기대 결과는 바꾸지 않았다.
- N7d 단독 실행: 시작 출력 보류는 적용하되 기존 `pending.size < 32` 조건인 후보에서 **1 FAIL / 종료1**. 이미 32키인 경우 기존 `flow-a`의 seq2를 잘못 버리고 ACK했다. `(pending.has(output.id) || pending.size < 32)`로 기존 키를 재사용하게 고친 뒤 통과했다. payload 상한은 그대로다.
- 최종 `npx playwright test tests/terminal-flow.spec.ts -g 'N7|cumulative output|parsed output|replacement generation|project and generation|disposing a terminal' --reporter=list`: **9 PASS / 종료0**. N7 신규4개와 기존 입력의 프로젝트/세대·dispose 및 출력의 누적ACK·parse완료·세대교체 5개를 실행했다. 전체 suite를 실행했다고 보고하지 않는다.
- `npm run build`: TypeScript 검사와 Vite 38 modules 빌드 **종료0**. 기존 500kB chunk 경고 유지. 지정3개 파일 `git diff --check` **종료0**.

원시 로그와 trace: `artifacts/native-startup-renderer/{red.log,green.log,limit-red.log,targeted-green.log,build.log,red-traces/,limit-red-traces/}`. Native N1–N6·Windows 실제 PTY/IPC·가시성/대화 owner 정책은 이 N7 결과의 검증 범위에 포함하지 않는다. 원래 입력 금지 정책·ACK coalescing·stopped tail drain을 보존했다.
