# 프로세스 통합 사전 시험 계획

상태: READY(사례 설계), 모든 제품 동작 시험 NOT_RUN. 제품/시험 소스 수정, 빌드, 앱·daemon·fixture 실행, commit/push는 이 담당에서 수행하지 않았다.

요구: 사용자 원문 `한 프로세스에 못 몰아넣어?`의 배정된 해석은 세션별 `opendiy-desktop-helper.exe`를 없애고 본체가 직접 관리하는 것이다. 이름 변경, 숨김, 별도 helper 한 개로의 대체는 충족하지 않는다. Codex·shell 등 실제 작업 프로세스 자체를 본체에 내장하라는 해석은 하지 않는다.

대상: `D:/codex/build/opendiy-desktop-process-1104`, 기준 `ffec9fc`, 작업 브랜치 `fix/process-consolidation`. 원시 사용자 config/auth, 다른 세션 로그, 전역 운영 daemon은 열람·실행·종료하지 않는다. 아래 실행은 구현 담당이 허용된 격리 fixture/CI에서만 수행할 계획이다.

## 확인한 실패 경계와 변경 범위

현재 `launch_gate.rs`는 console helper를 먼저 만들고 event 대기시킨다. 호출자는 helper를 Job에 넣고 reader·cron·expiry 등 정리 경로를 설치한 다음 release한다. 실제 자식은 그 뒤에만 생성되어 Job을 상속한다. 따라서 helper를 지우고 `spawn` 뒤 `AssignProcessToJobObject`만 호출하면 최초 자식의 자손 생성 race가 재발한다. 실제 프로그램 첫 실행 전 Job 소유권과 실패 정리 경로가 완성되어야 한다.

`session.rs:427-458`의 PTY, `codex.rs:422-433`의 owned app-server, `codex.rs:673-682`의 기존 daemon proxy, `codex_extensions.rs:184-201`의 단발 CLI가 직접 변경 경계다. OS 프로세스·thread·pipe·ConPTY handle을 본체에서 소유하는 새 launch 경계는 별도 API 담당의 실현성 결과를 받아 정한다. `ProcessJob`의 kill-on-close, 직접 자식 wait, 세션 generation, pipe/TCP peer 신원 검사는 유지해야 한다.

앱 Job은 앱 비정상 종료 시 소유 자손을 회수한다. 세션 Job은 해당 PTY/owned server/proxy 수명에만 속한다. 단발 명령 Job은 명령의 완료·timeout·취소·overflow까지다. `assign_daemon_launcher`의 명시 breakaway만 공유 daemon 생존을 허용한다. 외부 daemon 신원이나 전역 프로세스 개수로 개별 소유권을 대체하면 안 된다.

패키징 경계: `src-tauri/Cargo.toml:14-18`, `src-tauri/src/helper_main.rs`, `src-tauri/tauri.bundle.conf.json:7`, `.github/workflows/windows.yml:36,45,52,59`. `src-tauri/tests/native_pty.rs:3-5`의 helper bin `env!` 참조는 bin 제거 시 컴파일 오류이므로 동시 수정 대상이다. `tests/native-smoke.mjs:269-285`의 helper 이름 count=0은 제거 이후 회수 oracle로서 무력해진다. helper 부재와 실제 직접자식 회수를 분리해 검사해야 한다.

## 고정한 최소 사례

| case / CS 의무 | 수준·공개 진입점 / 기존 재사용 | 최소 수정·단계 | 독립 oracle와 거부할 실패 | 상태 |
| --- | --- | --- | --- | --- |
| C01 / O01 | Windows 실제 std/PTY launch 컴포넌트; `process_job_tests.rs` fixture, `launch_gate.rs` 환경 fixture 재사용 | std와 PTY 각각 실제 프로그램 최초 진입에서 PID·부모 PID·Job membership 보고. 시작 보류 상태에서 fixture 진입 불가 확인 후 commit/resume. 일반/daemon launcher 정책 모두 점검 | fixture가 OS의 부모 PID/`IsProcessInJob`을 직접 보고하고 부모가 보유한 생성 프로세스 handle PID와 같아야 한다. helper 없는 실제 자식이 처음부터 정확한 Job 소속이어야 함. spawn→assign race, 숨긴 wrapper, 다른 helper로 대체를 거부 | NOT_RUN |
| C02 / O02 | 실제 Job tree; `only_daemon_launcher_can_outlive_launcher_and_app_jobs` 재사용 | 기존 정상 앱 종료 보존, 격리 app fixture 강제 종료 분기 한 개 추가. query·PTY Job 종료→ordinary descendants 종료, daemon launcher 종료→명시 breakaway fixture 생존, 앱 정상/비정상 종료→ordinary 자식 종료 | PID+생성 시각에 결속한 보유 handle의 wait 신호. 이름/전역 count만 보지 않음. 시험이 생성한 daemon fixture만 종료. 실제 전역 daemon은 건드리지 않음 | NOT_RUN |
| C03 / O03 | std launch/CLI 경계; 환경 fixture 실패 경로와 `command_output_with_job` 재사용 | helper PID≠실제 child PID 기대를 직접 child PID 일치로 변경. 빠른 exit 0/7·최종 stdout/stderr marker 분기 추가, 리더 시작 전 빠른 종료도 결과 수집 | OS exit code 0/7 그대로 전달, 고정 최종 bytes 보존, child wait와 Job 0 확인. 조기 exit를 assign 실패/성공 0/출력 누락으로 바꾸는 구현을 거부 | NOT_RUN |
| C04 / O04 | 새 launch 경계의 획득/commit fault injection | 기존 RAII cleanup 활용. 실제 child 확보 직후, Job 편입 실패, resume 실패, I/O/worker 설치 실패 각 경계의 최소 실패 주입. 존재하지 않는 실행파일도 검사. 새 범용 framework 불필요 | 실패 반환·실제 프로그램 진입 marker 없음·획득한 프로세스 handle wait 완료·Job active=0·reader/expiry 종료. 미시작 실패와 시작 후 실패를 구별. 순수 mock만으로 suspended child 회수를 인정하지 않음 | NOT_RUN |
| C05 / O05 | `owned_helper_preserves_child_environment_without_cross_launch_leaks`, 실패/deadline 환경 시험 재사용 | 독립 환경을 가진 동시 3개 launch, inherited 환경, 한글/비ASCII OsString, 일반 child의 cron control token 제거를 보존. helper 어휘와 PID oracle만 직접 실행 계약으로 바꿈 | fixture UTF-16 값과 수작업 expected 비교; 부모 환경 전후 동일; 각 child 고유 값, 일반 child에 token 없음. 전역 환경 변경·상호 섞임을 거부 | NOT_RUN |
| C06 / O06 | `owned_cli_runner_enforces_overflow_timeout_and_descendant_pipe_cleanup`, `daemon_launcher_capture_reaps_readers_without_stopping_escaped_pipe_holders` 재사용 | 기존 overflow/timeout/pipe-leak와 escaped-pipe/timeout/cancel/overflow 그대로 실행 | 각 고유 오류 분류, 8 MiB 상한, 원래 deadline 안 종료, final stdout/stderr tail, 자신이 소유한 ordinary 자손 회수, escaped fixture 생존을 직접 관측. EOF 대기 무한연장/daemon 종료/성공 위장 거부 | NOT_RUN |
| C07 / O07 | Engine.start/stop 공개 경계; preparing stop, resume 취소, launch guard, metadata lock 시험 재사용 | commit/resume 전후의 stop 경합을 새 launch 경계에 연결. 늦게 설치된 프로세스도 stop 처리. shared stop 미확인을 stopped 성공으로 바꾸지 않음 | public metadata의 상태·active·generation, 실제 보유 child handle 종료, 진행된 결과 확정 여부. stop 요청만으로 정리완료를 발표하는 경로 거부 | NOT_RUN |
| C08 / O08 | 기존 `native_pty.rs`→실제 exe `--self-test`; `self_test.rs` Harness와 resize tests 재사용 | isolation, generation_and_lifecycle, bounded_output_cancellation, create_stop_cycles, process_tree_cleanup, blocked_input_stop 그대로 보존. 새 PTY API가 resize를 대체하면 fixture가 Console screen size를 직접 읽는 110x32 확인 한 항목 추가 | 한글+emoji 고정 입력 marker, TERM/COLORTERM, 교차 출력 없음, stale generation 거절, exit7 error, write 정체 관측 후 stop 해제, 실제 shell/손자 handle 종료. resize 반환값만으로 실제 크기를 증명하지 않음 | NOT_RUN |
| C09 / O09 | clean package 정적 검사+기존 packaged self-test | CI helper build/copy/zip/resource/bin 참조 제거. 깨끗한 staging의 본체 하나로 packaged self-test 실행. native-smoke helper count oracle는 child 신원 회수 oracle로 대체하거나 직접 회수시험 연결 | 패키지 실제 파일 목록에 helper 없음, live fixture tree에 wrapper 없음, body가 실제 작업 child 직접 관리, report fail=0과 기존 필수 항목. stale helper가 놓인 개발폴더 성공을 충족 근거로 쓰지 않음 | NOT_RUN |

C01/C04/C03과 C02의 crash 분기만 새 launch 실패경계 때문에 추가한다. C05/C06/C07/C08은 기존 동작을 검증하므로 기존 시험을 우선 재사용한다. resize 치수 항목은 대체 PTY 구현에만 적용하며 기존 resize 경로가 그대로면 새 시험을 강제하지 않는다.

## 실행 순서와 증거

1. 제품 구현 전에 이 목록을 고정하고 API 선택이 Job 편입 이전 실행을 허용하는지 정적으로 확인한다. C01/C04의 주입 지점은 선택한 OS API가 확정된 뒤 최소 hook으로 정한다.
2. 격리 사본/Windows CI에서 해당 source commit과 허용된 fixture로 C01~C07, resize 관련 시험을 실행한다. runner는 기존 `cargo test --locked --manifest-path src-tauri/Cargo.toml -- --nocapture`, `RUST_TEST_THREADS=2`를 재사용한다. 새 dependency/runner는 추가하지 않는다.
3. `src-tauri/tests/native_pty.rs`와 clean packaged self-test로 C08/C09를 실행한다. 운영 앱·기존 daemon에 연결하는 native smoke 전체를 임의 실행하지 않는다.
4. 각 실행에 commit SHA, 정확한 명령, 종료 코드, fixture PID+생성시각, assertion 원시 stdout/stderr, report 경로를 보존한다. assertion FAIL, launcher/env ERROR, deadline TIMEOUT, 미실행 NOT_RUN을 분리한다. 기존 실패를 성공 재실행으로 덮지 않는다.

proof/result: 사전 계획 작성 시 제품 검증은 전부 NOT_RUN이며 red/green 또는 mutation 근거가 없었다. 계획·CS JSON 구조 검사 성공은 제품 PASS, API 실현성, 실제 자원 회수 증거가 아니다. 구현 뒤 가능하면 C01의 Job 적용 제거/늦춤, C02 kill-on-close 제거, C06 취소·output 상한 제거에 해당하는 표적 반례를 격리 사본에서 실행해 해당 assertion이 실패하는지 확인한다. 운영 소스 reset이나 필수 기대값 완화는 하지 않는다.

## CS 적용 범위

`OS-LIFETIME-001`(draft)은 실제 Windows 프로세스 통합으로 process/thread/pipe/ConPTY/Job handle의 획득·해제 주체가 바뀌기 때문에 명시적으로 도입한다. `CONC-CANCEL-004`는 launch/stop/finish 경합, `CONC-LOCK-003`은 process/termination/writer/adapter/cron lock 아래 cleanup·join의 대기에만 적용한다. claim/DB/메시징/파일 게시/시계점프 카드는 이 변경에 새 의무를 만들지 않는다. lock 검증 O10은 정적 획득 순서·락 아래 blocking I/O/join 검토이며 실제 정체 취소는 C08의 기존 fixture로 관측한다.


## 구현 후 확인 기록

- 첫 통합 후보 `151b6c4`: Windows CI `41823806866`에서 E2E 385 PASS·1 skipped, Rust 332 PASS·2 FAIL·6 ignored. 직접 부모·Job·빠른 종료·시작 실패·정상/강제 앱 종료 사례는 실행됐으며, 전체 성공으로 판정하지 않는다. 원시 기록은 작업 사본 artifacts/ci-151b6c4.log에 보존한다.
- 대량 출력 실패는 CreatePipe 기본 버퍼와 기존 20ms polling의 상호작용을 원본 C# 8MiB+1KiB 출력 및 제품 capture 함수 그대로 재현했다. timeout10초와 8MiB 상한을 보존한 채 64KiB 버퍼로 바꿔 판별했다. 이 소규모 실행은 전체 제품 수용을 대신하지 않는다.
- C07에는 실제 Engine.launch의 process slot 설치 직후 실패를 주입해 완료 Changed 시점의 slot 제거·원래 child handle 종료·unknown 1회 발표를 검사하는 회귀를 추가했다. 선행 finish를 유지한 후보를 먼저 실행해 탐지능력을 확인한 다음 해당 한 줄을 제거한다. cfg(test) one-shot probe만 사용하며 생산 빌드에 주입 기능을 넣지 않는다.
- 이후 후보의 전체 CI·패키징·독립감사는 각 고정 SHA의 별도 실행 근거로 판정한다. 진행 중인 사용자 앱·daemon·개인 설정과 인증은 이 시험의 대상이 아니다.

- C07 회귀 탐지 확인: 의도적으로 선행 finish를 유지한 `cba044b`/CI `41826480978`은 334 PASS·1 FAIL·6 ignored였다. 새 actualEngine.launch 시험만 stopped(slot 잔존)→unknown 두 번의 완료 발표를 검출했다. 이전 두 실패인 출력 overflow 분류와 공유 proxy 회수 경합 시험은 이 후보에서 통과했다.
- 같은 실패에서 원래 child handle의 미신호 완료가 드러나 upstream WinChild의 exit-code 단독 종료판정을 별도 판별했다. 실제 kill/JobTerminate 각128회에서 wait가 signal 전에 반환하는 RED를 확인했고, signal 우선 판정으로 변경 후 각128회 조기반환0 및 exit259 회귀를 확인했다. 이 부분 standalone은 library9 PASS·fixture entry1 ignored·doctest1 PASS이며 전체 후보의 통합 GREEN은 별도로 확인한다.

- O04 보강: 실제 child·Job·파이프를 가진 상태에서 pty-output/pty-reaper/Proxy deadline·reader/CLI stdout·stderr 각 worker 설치를 1회 실패시킨다. 시험에만 포함되는 caller-thread-local scope가 주입하며, 원래 process/Job handle·진입 marker·앞서 생성한 worker의 실제 시작/종료·완료 이벤트를 관측한다. 생산 코드는 표준 Builder.spawn 오류를 반환하고 reaper 설치 실패에도 reader JoinHandle을 ProcessControl이 보유·회수한다. 이 추가 회귀는 최종 후보 CI에서 실행해야 한다.
- `a4a1c1d`는 native 335 PASS·6 ignored 및 vendor9 PASS·1 ignored 뒤 E2E 384 PASS·1 FAIL·1 skipped였다. trace의 직접 실패는 xterm SearchAddon 개발 모듈 요청의 net::ERR_NO_BUFFER_SPACE와 빈 #app이며, 기능 버튼 oracle에 도달하지 못했다. 원시 실패를 보존하고 브라우저/네이티브 검증을 별도 Windows 실행기로 분리한다. 기존 required windows job은 양쪽 성공을 확인한 뒤에만 패키징한다.
- CI의 화면 검증은 같은 npm build 배포 번들을 preview로 제공한다. 기존 사례·timeout·기대값은 변경하지 않는다. 이 PC에서 번들 모드의 원래 capability 5사례를 실행해5 PASS·exit0을 확인했으며 전체 E2E와 패키징은 최종 후보 결과를 별도로 확인한다.
- `f518613`의 native는 341 PASS·6 ignored, 실제 실행 파일 통합1 PASS, vendor9 PASS·1 ignored였다. 전체 E2E를 preview로 바꾼 시험 설정은 238 PASS·147 FAIL·1 skipped였으며, 실패 사례는 `/src/*.ts` 직접 import에 의존해 배포 번들 서버에서 해당 fixture를 만들지 못했다. 이 실패는 제품 성공으로 처리하지 않는다.
- 수정한 시험 실행 계약: 원래 386개 사례는 개발 서버를 필요로 하는 소스 fixture까지 원래 방식으로 모두 실행한다. 별도 단계에서 동일한 배포 번들 preview로 원래 독립 기능 버튼5사례를 다시 실행해 앞선 SearchAddon 실패 경계를 포함한다. 기대값·timeout·재시도·사례는 바꾸지 않으며, 어느 단계가 실패해도 패키징을 허용하지 않는다. 브라우저와 native는 별도 Windows 실행기를 유지한다.

## reaper 설치 뒤 시작 실패의 완료 소유권 (사전 사례, 2026-11-05)

아래 사례는 제품 수정 전에 정한 C07/O07/O10의 보강이다. 기존 Windows `session_launch_guard_tests.rs`와 실제 `Engine.launch`·PTY·Job·reader를 재사용한다. 로컬 Cargo가 확인되지 않아 실행 상태는 모두 NOT_RUN이며, CI의 고정 후보에서 실제 결과를 별도로 기록한다.

| 사례 | 입력·전제·절차 | 기대 결과·판정 기준 | 실제 결과 |
| --- | --- | --- | --- |
| C10 reader 대기 중 activation sink 실패 | 자체 PowerShell child가 고정 marker를 출력한다. 실제 reader의 Output sink를 channel로 보류하고 activation Changed sink는 marker 진입 뒤 오류를 반환한다. reader를 해제하기 전 완료 이벤트·phase3·done을 관측한 뒤 해제한다. | reader 보류 중 완료 이벤트 없음·phase<3·done=false. 해제 후 launch는 원래 sink 오류, terminal error 1회, process slot 없음·원래 child handle 신호·Job active=0·done=true. 성공한 reaper spawn 뒤 Guard와 reaper가 각각 finish하는 구현을 거부한다. | NOT_RUN |
| C11 resume 거부·metadata 저장 실패 | 기존 post-install probe에서 정확한 fixture child를 종료·wait하여 실제 pending.try_resume의 exited-before-resume 오류를 만든다. 별도 실행은 기존 pre-reader probe에서 자체 메모리 Store mutex만 poison하여 실제 activation save 경로를 실패시킨다. | 각각 원래 resume/store 오류 반환. metadata unlock→pending rollback 뒤 단일 reaper가 reader를 회수하고 phase3·done을 발표한다. 저장 실패는 terminal 이벤트 미전달을 성공 전달로 바꾸지 않으며 최종 메모리 상태 error·active=false, child 신호·slot 없음. | NOT_RUN |
| C12 실패와 사용자 stop·공유 결과 불명 | C10을 사용자 stop 요청, shared cleanup 불명 flag와 stop-attempted flag를 가진 자체 fixture로 각각 실행한다. 실제 공유 RPC는 호출하지 않는다. | 정상 stop은 stopped 1회, 공유 중단 불명은 unknown 1회. launch 오류는 원래 sink 오류이며 unknown을 stopped로 덮지 않는다. 추가 shared stop 전송 없음은 기존 at-most-once 시험과 결합해 검증한다. | NOT_RUN |
| C13 activation 전달 중 빠른 정상 종료 | 자체 child는 exit0. activation sink를 channel로 보류한 상태에서 원래 child handle의 신호를 확인한다. 그동안 완료 이벤트·phase3·done을 검사하고 sink를 성공으로 해제한다. | activation 성패 확정 전 완료 없음. 해제 후 exited 1회·active=false·slot 없음·done=true. reaper가 activation보다 먼저 완료하는 구현을 거부한다. | NOT_RUN |

각 channel 대기는 정해진 조건과 deadline을 사용하며 성공할 때까지 재시도하거나 고정 sleep으로 순서를 만들지 않는다. 실패 assertion 전에도 reader/activation channel을 해제하여 자체 fixture를 회수한다. Guard의 unbounded join은 기존 reader join과 같은 종료 전제(정확한 자식 종료·ConPTY close로 reader 해제)를 유지하며 시험 외부의 15초 watchdog으로 정체를 구별한다. channel 수신자가 사라지면 send는 오류로 즉시 반환하며 재전송하지 않는다.

회귀 탐지 계획: 격리 사본의 고정 `cef65c52c37e5a5536e0de378622250fdee581ea` 제품 코드와 같은 새 시험 bytes로 C10/C13 RED, 수정 후보 GREEN을 실행한다. 제품 변경 때문에 필요한 시험 전용 필드 초기화는 컴파일 호환 패치로만 양쪽에 같게 적용한다. RED의 assertion witness와 실제 실패 경계를 확인하며 컴파일 오류를 RED로 세지 않는다. 기존 post-install 실패·output/reaper worker 설치 실패·startup DSR·stop 경합 시험도 유지한다.

CS 조건은 `CONC-CANCEL-004`의 완료 전 reader 회수와 error/stopped/unknown 전이, `CONC-LOCK-003`의 metadata·termination·process·adapter 락 밖 channel/join 대기로 제한한다. 새 completion 원자 플래그로 phase3만 막는 방식은 reader join 완료를 증명하지 못하므로 허용하지 않는다. native OS ResumeThread 자체 오류 주입은 이 범위에서 하지 않으며 C11은 실제 ResumeToken의 종료 전 검사 거부 경계임을 구별한다.

### C10/C13 headless renderer 전제 보정 (2026-11-05)

`6f97f32` Windows CI native에서 C10은 marker/activation 실패 경계에 도달하지 못했고 C13은 원래 child handle wait가 258(TIMEOUT)이었다. 컴파일 성공과 다른 사례 통과를 이 두 사례의 GREEN으로 바꾸지 않는다. 원시 실패는 `verification/desktop-1.2.0-20261105/launch-completion-fix/fixture-dsr/ci-green-6f97-native-original.log`에 보존했다. 이 두 sink에는 ack만 있었고 기존 startup DSR/resize fixture와 달리 ConPTY cursor 질의 응답이 없었다. 같은 CI의 기존 resize fixture는 cursor 질의 1회·응답 성공·marker/exit 진입을 기록했다. 이는 DSR 전제 누락 가설의 근거이며 실패한 두 사례 자체의 질의 수는 미관측이었다.

다음 판별에서는 C10/C13의 자체 headless sink가 기존 startup fixture처럼 chunk 경계를 넘는 `\x1b[6n`을 감지하고 실제 `Engine.write`로 `\x1b[1;1R`을 회신한다. 실제 reply 성공/오류를 기록하고, 원래 marker·child wait·activation/reader-before-done·단일 완료 oracle와 모든 deadline은 그대로 둔다. 이 변경은 시험 전제 보정이며 제품 코드 수정이 아니다. 다음 고정 후보의 실제 질의/회신·marker/child 종료와 RED assertion 결과를 확인하기 전까지 원인을 확정하거나 통과를 선언하지 않는다.
