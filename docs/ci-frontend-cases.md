# CI 프런트엔드 시험 분리

PR #4의 `f6eff70` push 실행 `42155183342`에서 화면 시험 1개가 초기화 전에 실패했다. 보존한 trace는 `/node_modules/.vite/deps/@xterm_xterm.js` 요청의 `net::ERR_NO_BUFFER_SPACE`를 기록한다. 전체 439개 사례는 437개 통과, 1개 실패, 1개 opt-in 제외였으며 Rust 검사는 통과했다. Windows 작업은 선행 프런트엔드 실패 때문에 패키징에 진입하지 않았다.

제품 동작이나 assertion을 바꾸지 않고, 배포 번들로 실행할 수 있는 화면 시험과 소스 모듈 import·route 변조를 사용하는 fixture를 구분한다. 기존 실패는 보존한다. 이미 공개된 1.3.2 태그와 자산은 변경하지 않는다.

## 실행 전 사례

| ID | 전제·입력 | 절차 | 기대 결과·판정 기준 | 실제 결과 |
| --- | --- | --- | --- | --- |
| CI01 | 수정 전 `f6eff70`의 439개 시험 목록 | 기존 목록과 분리된 두 단계 목록을 파일·suite·제목으로 비교한다 | 합집합이 기존과 동일하고 교집합은 비어 있다. 시험 삭제·추가 skip으로 수를 맞추지 않는다 | PASS: source 266 + bundle 173 = 439, 합집합 동일·교집합 0 |
| CI02 | 빌드된 `dist`, IPC만 대체한 기존 화면 fixture | preview 서버로 배포 화면 그룹을 실행한다 | 원래 화면 assertion이 모두 통과한다. 실패했던 runtime-compatibility 사례를 포함한다 | PASS: Windows Edge 173 통과, 실패·제외·재시도 통과 0 |
| CI03 | `/src/*.ts` import·source route 변조가 필요한 기존 fixture | 개발 서버로 source 그룹을 실행한다 | 원래 module/mutation assertion이 모두 유지된다. startup의 의도적 모듈 로드 실패 사례도 포함한다 | PASS: Windows Edge 265 통과·기존 opt-in 1개 제외, 실패·재시도 통과 0 |
| CI04 | 실패했던 runtime-compatibility 화면 사례, 정상 배포 번들 | script·stylesheet 요청 실패와 `/src/`, `/@vite/`, `.vite/deps/` 개발 모듈 요청을 관측한다 | 배포 화면이 초기화되고 기존 호환성 assertion이 통과한다. 개발 모듈 요청이 없다 | PASS: 호환성 8개 별도 trace에서 배포 asset 요청 관측, 개발 모듈 요청·앱 script/style 오류 0. favicon.ico 404 1건은 별도 보존 |
| CI05 | 기존 PR #4와 수정 후보 | 기존 PR head로 통상 push 후 정확한 commit의 CI 결과를 확인한다 | frontend·native·windows 결과를 각각 확인한다. 취소·의존 실패를 통과로 보고하지 않는다 | 원격 CI 확인 대기. 결과는 해당 PR 실행과 검증 자료에 보존 |

로컬 검증은 Chromium 계열 브라우저 한 writer와 포트 1420만 사용한다. 기존 의존성을 재사용하며 Rust 빌드는 Windows CI에 맡긴다. 운영 Desktop, 사용자 인증·설정·DB 및 공유 daemon을 변경하지 않는다. 로컬과 CI 결과 및 실제 제품 부하 검증은 구별한다.
