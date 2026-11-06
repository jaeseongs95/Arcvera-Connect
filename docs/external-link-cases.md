# 외부 링크 검증 사례 (구현 전 작성)

기준: 22551c6. 범위: 질문·대화·터미널의 명시 클릭으로 HTTP(S) URL을 기본 브라우저에 전달한다. 자동 열기, 임의 프로토콜, shell 문자열 실행은 금지한다. 기존 Playwright runner와 Rust 단위 테스트를 사용한다. 브라우저 시험의 native invoke는 stub이며 실제 OS 브라우저 실행을 증명하지 않는다.

| 사례 | 입력·사전조건 | 절차 | 기대 결과·통과 기준 | 실제 결과 |
| --- | --- | --- | --- | --- |
| EL-01 | 일반 본문 `https://community.openai.com/c/codex/37`, native invoke stub | 렌더링, hover, pointer click, keyboard Enter | 렌더링·hover 호출 0회, 명시 활성화마다 정확한 URL 1회, 페이지 이동 없음 | PASS: Playwright 공개 경계 (native invoke stub) |
| EL-02 | xterm OSC 8 label과 HTTP(S) target, native invoke stub | 출력 후 label hover·click | 자동 열기 0회, 클릭 1회, WebView popup 없음, target tooltip | PASS: Playwright 공개 경계 (native invoke stub) |
| EL-03 | 일반 URL이 xterm 열 폭을 넘어 wrap, CJK·emoji prefix, 후행 `).,` | 첫·이어진 줄의 URL hover·click | 전체 URL 한 번 전달, 괄호·문장부호 제외, 잘못된 셀 링크 없음 | PASS: Playwright 공개 경계 (native invoke stub) |
| EL-04 | Unicode host/path, query `?a=1&b=한글#부분`, balanced `(b)` | 본문·터미널에서 클릭 | URL 내용 보존·정규화, query·괄호 손실 없음, 표시 원문 보존 | PASS: Playwright 공개 경계 (native invoke stub) |
| EL-05 | javascript/file/data/mailto, leading spaces, literal/percent-encoded controls, backslash, malformed host | 공개 openExternalUrl 및 Rust validator 호출; OSC 8 disallowed target 클릭 | native launch 0회, 오류 반환·표시; 허용된 HTTP(S)만 전달 | PASS: TS/렌더러; Rust 단위 테스트 작성, CI 실행 대기 |
| EL-06 | native launch가 거절하는 stub | 본문·터미널 링크 클릭 | 예외가 오류 callback/기존 toast에 전달, 성공으로 처리·자동 재시도하지 않음 | PASS: TS/렌더러; Rust 단위 테스트 작성, CI 실행 대기 |
| EL-07 | terminal link controller | 출력·provider 확인 후 dispose, stale activation 호출 | provider 해제, 기존 handler 복원, stale callback 외부 실행 없음 | PASS: Playwright 공개 경계 (native invoke stub) |
| EL-08 | 대화 fenced code URL·본문 URL·HTML 같은 문자열 | 대화 렌더링·검색·코드 복사 | 코드 URL은 code text 유지, 본문 URL만 링크, HTML 실행 없음, 검색·복사 원문 보존 | PASS: Playwright 공개 경계 (native invoke stub) |
| EL-09 | radio label 내부 링크 | label 내부 anchor 클릭 | 외부 열기 1회, option 선택·form submit·dialog 닫힘 없음 | PASS: Playwright 공개 경계 (native invoke stub) |
| EL-10 | 최종 CI Windows native 시험 실행 파일과 기록한 SHA-256, `OPENDIY_REAL_BROWSER_TEST=1`; GUI·CLI 실행 없음 | ignored opt-in 시험에서 자체 `127.0.0.1:0` listener와 nonce URL 생성 → 실제 async `open_external_url` 호출 → 20초 이내 정확한 nonce HTTP GET 수신·응답 | native 명령 성공과 기본 브라우저의 실제 HTTP 수신을 각각 확인해야 PASS. 환경값 없음, launch 오류, 타깃 불일치·시간초과는 FAIL. 사용자 브라우저 탭·프로세스는 닫지 않음 | NOT_RUN (최종 CI 실행 파일 확보 후 root 실행) |
| EL-11 | 실제 대화의 구조화 질문 label/option/description URL | 질문 poll로 표시한 후 각 URL 클릭 | 질문·option 보조링크 native 전달, select 값·초안·응답 호출 횟수 보존 | PASS: Playwright 공개 경계 (native invoke stub) |
| EL-12 | main.ts 실제 세션 카드와 terminal-output 이벤트, native invoke stub | 실제 카드 URL pointer click 후 native 실패를 주입하고 재클릭 | 전체 제품 경로의 URL 전달·기존 오류 toast 확인; baseline main.ts는 같은 클릭 assertion 실패 | PASS: Playwright 공개 경계 (native invoke stub) |
| EL-13 | 실제 xterm 40열·scrollback 10000, 40공백+`ESC[1K`로 wrapped metadata를 유지한 erased 공백 3000행 및 6000행 뒤 짧은 URL | 공개 buffer/getLine/getCell 호출을 계측하고 URL 행 provider lookup | 공백 scrollback 길이와 무관하게 셀 mapping ≤8192, 행 접근 ≤430; 짧은 URL 전체가 유지됨. 수정 전후 실제 접근량을 기록 | PASS: 실제 xterm; 3000/6000행 모두 getLine 3, getCell 68 |
| EL-14 | 8192를 넘는 uninterrupted URL의 중간에 `https://other.example/short` 포함, 이후 공백과 정상 짧은 URL 및 여러 행으로 wrap되는 정상 URL | 긴 URL 중간·마지막 행 및 짧은 URL 행의 provider lookup | 잘린 token의 내장 URL·끝 URL을 별도 주소로 등록하지 않음. 같은 행의 공백 뒤 정상 짧은 URL과 wrapped URL은 유지, 매 lookup 셀 mapping ≤8192 | PASS: 실제 xterm; suffix/중간/wrapped 각각 getCell 8154/8154/8140 |

판정: 각 사례의 모든 기대 결과가 충족되어야 PASS. assertion 실패는 FAIL, runner/환경 오류는 ERROR, 실행하지 않은 경계는 NOT_RUN으로 남긴다. 자동 시험은 실제 브라우저 launch 경계를 대체하지 않는다. SOLID 경계: 렌더러의 텍스트/셀 링크화와 호스트의 URL 검증·OS 실행을 두 함수/모듈로 분리하며, 사용자 본문은 innerHTML에 전달하지 않는다.

## 실행 결과와 증거

- Windows, Node/Playwright/Chromium; fixture는 자체 DOM과 stub Tauri invoke만 사용한다. 기존 사용자 세션·인증·DB·운영 서비스를 열거나 변경하지 않았다.
- `npx playwright test tests/external-links.spec.ts --reporter=list`: 종료 0, 6개 PASS. 로그 `artifacts/external-links/final-playwright.log`.
- `npm run build`: 종료 0. 38개 module, 기존 500kB chunk warning 유지. 로그 `artifacts/external-links/final-build.log`.
- `npx playwright test tests/external-links.spec.ts -g EL-12 --reporter=list`: `EXTERNAL_LINK_BASELINE=1`일 때 작업트리 대신 Playwright route가 provider/OSC 8 설치만 제거한다. 종료 1, native 호출이 기대 URL 대신 빈 배열인 assertion으로 검출. 동일 argv의 정상 후보는 종료 0, 1개 PASS. 로그 `missing-provider-red.log` / `missing-provider-green.log`. 이는 원본 전체 checkout 실행이 아닌 표적 mutation이다.
- 첫 실행의 x10 기대 대 x9 실제값 실패는 xterm 기본 Unicode 6의 emoji 1셀 폭을 반영한 oracle 교정이다. 두 번째 실패는 Windows clipboard CRLF readback에 LF만 기대한 oracle 오류다. 실제 `writeText` payload의 LF 원문은 exact assertion으로 보존하고 readback만 CRLF를 정규화했다. 제품 복사 코드와 URL 셀 구현은 이 두 실패 때문에 바꾸지 않았다. 원시 실패 trace와 설명을 `artifacts/external-links/`에 보존했다.
- Rust 3개 단위 테스트는 HTTP(S)/Unicode 재정규화, 금지 URL, 검증 후 launch·실패 전달을 검사한다. 로컬 대형 Rust 빌드 제한에 따라 여기서는 실행하지 않았다. CI 실행 책임은 root에게 인계한다.
- 실제 기본 브라우저의 OS 실행과 patched native 앱의 클릭은 EL-10 NOT_RUN. 프런트엔드 invoke stub은 그 경계를 증명하지 않는다. 전문 CLI check-plan/check-proof receipt는 발급하지 않았으며, 위 자연어 계획·실행 로그·표적 mutation 근거를 root의 수용/독립 감사에 전달한다.

## EL-10 opt-in 실제 브라우저 시험 준비

이 사례의 검증 범위는 **실제 native command → Windows ShellExecuteW → 기본 브라우저 → 자체 loopback HTTP 수신**이다. GUI 클릭·Tauri IPC는 EL-01/02/12의 별도 시험 경계다. 실제 앱 전체의 클릭 검증으로 확대 해석하지 않는다. 기존 GUI runner를 재사용하려던 준비는 중단했으며, 이 시험은 운영 Desktop PID 18396, GUI 단일 인스턴스, CLI, HOME/auth/DB, 운영 서비스와 무관하게 실행한다.

준비한 시험 이름: `external_links::tests::real_windows_default_browser_reaches_own_loopback`. `#[cfg(windows)]`와 `#[ignore]`로 일반 CI 실행에서 제외하며, 직접 선택해도 opt-in 환경값이 정확히 `1`이 아니면 명시적으로 실패한다. 금지 URL이 launch 전에 거절되는 경계는 기존 `native_launch_boundary_rejects_before_launch_and_preserves_failure` 및 `external_url_boundary_rejects_protocols_controls_and_missing_authority` 시험이 담당한다. 새 시험은 nonce URL과 요청 첫 줄만 출력하고 headers/auth를 저장하지 않는다.

root가 최종 CI artifact에서 받은 **정확한 test-runner 경로·SHA-256·후보 커밋**을 먼저 기록한 뒤 실행할 argv:

```powershell
$testRunner = '<최종 CI artifact의 test-runner.exe 절대 경로>'
Get-FileHash -LiteralPath $testRunner -Algorithm SHA256
$env:OPENDIY_REAL_BROWSER_TEST = '1'
try {
  & $testRunner --ignored --exact external_links::tests::real_windows_default_browser_reaches_own_loopback --nocapture --test-threads=1
  $testExit = $LASTEXITCODE
} finally {
  Remove-Item Env:OPENDIY_REAL_BROWSER_TEST -ErrorAction SilentlyContinue
}
exit $testExit
```

실제 실행은 여기서 하지 않았다. 브라우저는 자기 loopback nonce 페이지를 탭으로 열 수 있으며, 시험이 탭이나 프로세스를 닫지 않는다. listener와 수신 socket만 시험 범위에서 해제한다. 해당 탭은 사용자가 필요에 따라 닫는다. launch 성공 응답만으로 PASS 처리하지 않으며 정확한 GET 수신까지 필요하다. 실제 브라우저 HTTP(S) 중 이 사례가 관측하는 프로토콜은 HTTP다.

## EL-13/14 실제 비용 계측과 후속 수정

`cs-engineering`의 ALG-COST-003 관점에서 진행 척도를 출력 문자열 길이 대신 실제 행의 셀 폭으로 고정했다. 요구 불변조건은 (1) 한 조회의 mapping 셀 읽기와 UTF-16 위치 배열 길이가 각각 8192 이하, (2) 잘린 token의 중간·끝을 새 주소로 등록하지 않음, (3) 인접한 정상 짧은 링크·wrapped 링크 보존이다. 메타데이터 탐색도 양방향 각각 8192셀 문맥 이하이며, 가까운 공백 token 경계에서 멈춘다. 전체 scrollback 길이를 비용 상한으로 삼지 않는다. 셀 객체는 공개 `getNullCell` API로 하나를 재사용한다.

초기 실제 xterm 측정에서 단순 출력한 40공백은 `translateToString(true)` 길이가 0이 아니었다. 그 입력은 getLine 617/getCell 8228로 한 행 초과를 보였지만 무제한 공백 문제의 재현은 아니었다. `ESC[2K`는 wrap flag도 지워 getLine 7/getCell 69였으므로 재현으로 채택하지 않았다. **`40공백 + ESC[1K` 3000회**는 wrap flag를 보존한 erased 행을 만들었고 수정 전 getLine **15001**, getCell **123028**로 실패했다. 같은 조회에서 긴 URL 내부 `https://other.example/short`를 잘린 별도 링크로 등록하는 결함도 함께 관측했다.

수정 후 실제 xterm 3000행·6000행 두 입력 모두 getLine **3**, getCell **68**이며 정상 URL을 유지했다. 긴 token 마지막 행은 getLine 206/getCell 8154, 중간 행은 302/8154, 인접 정상 URL이 여러 행으로 wrap되는 경우는 208/8140이었다. 내부 주소는 등록하지 않고 인접 정상 URL만 전체 주소로 등록했다. 좌표는 각 UTF-16 위치의 시작·끝 배열을 8192 항목씩 넘지 않게 생성한다. 상한 때문에 문맥이 잘린 token은 보수적으로 링크를 제공하지 않는다.

`npx playwright test tests/external-links.spec.ts --reporter=list`: 기존 6개 + 비용 회귀 1개, **7 PASS / 종료 0**. `npx tsc --noEmit`와 해당 3개 파일의 `git diff --check`도 종료 0이다. 실제 브라우저 실행은 이 후속 수정에서 수행하지 않았다. 이 계측은 공개 API의 행·셀 접근량이며, JS heap 사용량이나 실제 운영 앱의 hover 지연을 직접 측정한 결과로 확대하지 않는다.
