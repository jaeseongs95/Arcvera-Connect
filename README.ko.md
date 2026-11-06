# OpenDIY Desktop

여러 Codex CLI 세션을 나란히 사용하는 Windows 작업 공간입니다.
대화를 프로젝트별로 묶고, 터미널 격자의 크기를 조절하고, 저장된 작업을 이어갈 수 있습니다.

[English](README.md) | **한국어**

[다운로드](https://github.com/jaeseongs95/opendiy-desktop/releases/latest) ·
[빠른 시작](#빠른-시작) · [사용 가이드](docs/user-guide.ko.md) ·
[개발 가이드](docs/development.md)

![OpenDIY Desktop에서 프로젝트와 실행 중인 세션을 전환하는 모습](docs/loading-demo.gif)

*2026-10-30 실제 사용 중 촬영한 원본 속도 영상입니다.
사용 예시이며, 성능 비교나 최신 배포판의 실행 영상은 아닙니다.*

## 지원하는 Codex

Desktop과 Codex는 별도로 설치합니다. Desktop **1.2.0**의 문서상 지원 기준은 다음과 같습니다.

| 실행 환경 | 지원 범위 |
| --- | --- |
| [OpenDIY Codex](https://github.com/jaeseongs95/opendiy-codex) R36 CLI와 같은 패키지의 R36 앱 서버 | 기본 터미널·세션 기능과, 필요한 지원이 확인된 확장 기능. R28을 포함한 이전 OpenDIY 버전은 지원 대상에서 제외합니다. |
| [공식 Codex CLI](https://github.com/openai/codex) 0.166.0 | 기본 터미널·세션 기능. OpenDIY 확장 기능의 지원을 전제하지 않습니다. |

확장 기능은 선택한 CLI와 연결된 서버의 실제 지원 여부, 연결 상태와 작업 상태에 따라 활성화됩니다.
버전 번호만으로 기능 지원을 보장하지 않습니다.
[실행 파일 선택과 서버 전환](docs/user-guide.ko.md#runtime)에서 자세히 설명합니다.

## 빠른 시작

1. **Codex를 설치하고 로그인합니다.** 위 표의 실행 환경을 사용하세요.
   Desktop 배포 파일에는 Codex가 포함되어 있지 않으며, 앱이 내려받지도 않습니다.
2. **Desktop을 설치하거나 압축을 풉니다.**
   [릴리스](https://github.com/jaeseongs95/opendiy-desktop/releases/latest)에서 Windows x64 설치 파일이나
   포터블 ZIP을 받으세요. Windows와 WebView2가 필요하며, 실행 파일은 서명되어 있지 않습니다.
   포터블은 **ZIP 전체를 풀어** 사용하세요.
   릴리스의 `SHA256SUMS.txt`와 다운로드한 파일의 해시를 대조할 수 있습니다.
   설치한 앱 또는 `opendiy-desktop.exe`를 실행하세요.
3. **CLI를 선택합니다.** **⚙ 설정 → 실행 파일 설정**에서 네이티브 `codex.exe` 또는 설치된
   `opendiy-codex-launcher.exe`를 선택하세요. 서버 실행 파일은 자동으로 선택되며 별도 지정은 선택 사항입니다.
   경로를 바꿔도 실행 중인 공유 서버를 교체하거나 열린 터미널을 재시작하지 않습니다.
4. **프로젝트와 세션을 엽니다.** **프로젝트 가져오기**에서 기존 폴더를 선택한 뒤 이전 대화를
   이어가거나 새 세션을 만드세요. 모델 선택·로그인·권한 질문은 CLI 화면에서 처리합니다.
   CLI 입력란의 줄바꿈은 **Shift+Enter**입니다.

기본 화면 언어는 한국어입니다. **설정 → 언어**에서 **한국어 / English**를 선택하면 앱과 트레이의
언어가 바뀝니다. CLI 출력과 Windows 시스템 문구는 각자의 언어를 유지합니다.

## 원하는 작업 찾기

| 하고 싶은 일 | 안내 |
| --- | --- |
| 세션을 묶고 프로젝트 순서나 격자를 바꾸기 | [프로젝트와 터미널](docs/user-guide.ko.md#projects) |
| 저장된 대화 이어가기, 특정 세션 재시작 | [기록·복원·재시작](docs/user-guide.ko.md#restore) |
| 대화 보기에서 질문·승인에 답하기 | [대화 보기와 질문함](docs/user-guide.ko.md#conversation) |
| 설치된 플러그인 관리, 새 플러그인 찾기, 스킬 관리 | [플러그인과 스킬](docs/user-guide.ko.md#extensions) |
| Hook 조회, 사용 설정과 신뢰 검토 | [Hook](docs/user-guide.ko.md#hooks) |
| 직접 생성한 서브에이전트 조회·관리 | [서브에이전트](docs/user-guide.ko.md#subagents) |
| 사용량 확인, 특정 세션의 컨텍스트 크기 조절, 압축, 작업 예약 | [컨텍스트](docs/user-guide.ko.md#context) · [예약](docs/user-guide.ko.md#schedules) |
| 실행 중인 세션을 휴대전화와 연결 | [모바일 원격 제어](docs/user-guide.ko.md#mobile) |
| 주간 사용량과 첨부 이미지 저장 공간 확인 | [사용량](docs/user-guide.ko.md#usage) · [저장 공간](docs/user-guide.ko.md#storage) |

## 종료·데이터·제약

- **창을 닫으면 트레이로 숨겨집니다.** 완전히 종료하려면 **앱 종료**를 사용하고 앱이 소유한
  프로세스의 정리를 확인하세요. 다음 실행에서는 저장된 대화 ID로 새 프로세스를 연결합니다.
  이전 프로세스 ID를 되살리거나 지난 입력을 다시 보내지 않습니다.
- Desktop이 작업 프로세스를 직접 실행하고 Windows Job으로 소유·정리합니다.
  별도 Desktop helper 실행 파일은 필요하지 않습니다. Codex·셸·WebView2는 별도 프로세스로 실행됩니다.
- 인증·설정·대화 기록은 Codex가 관리합니다. Desktop은 배치·프로젝트·세션 메타데이터·환경설정을
  자체 SQLite에 저장하며, 그 데이터베이스에 Codex 인증 파일이나 터미널 전문을 복사하지 않습니다.
  전송한 붙여넣기 이미지는 대화 기록에서 참조할 수 있어 별도로 보존합니다.
- 화면과 입력 버퍼에는 상한이 있습니다. 모델 문맥을 잘라내는 제한이 아니며,
  CLI 프로세스의 메모리 사용량 상한을 보장하지도 않습니다.
- 휴대전화 실기 페어링·제어와 장시간 메모리 누수 시험은 아직 검증하지 않았습니다.
  실제로 실행한 시험과 제약은 각 릴리스의 설명을 확인하세요.

데이터 소유권, 재시도와 복구 동작은 [사용 가이드](docs/user-guide.ko.md)에 정리했습니다.

## 개발과 검증

Tauri 2, Rust/portable-pty, TypeScript, Vite, xterm.js를 사용합니다.
[개발 가이드](docs/development.md)에 준비 사항·빌드·패키징·진단 명령을 정리했습니다.
Windows CI에서 검사와 패키징을 수행하지만, 빌드 성공만으로 GUI 동작이나 모든 CLI 조합의 호환성을
입증하지는 않습니다.

과거 관측 자료와 그 범위는 [검증 안내](docs/development.md#verification)에서 확인할 수 있습니다.
[문제 제보](https://github.com/jaeseongs95/opendiy-desktop/issues)에는 Desktop 버전, 선택한 CLI·서버 버전,
재현 절차와 기대 결과·실제 결과를 적어 주세요. 인증 정보나 개인 대화 로그는 첨부하지 마세요.

## 라이선스와 방향

독립적으로 구현한 [MIT 라이선스](LICENSE) 프로젝트입니다. Claudes의 다중 터미널 작업 흐름을
제품 참고로 삼았으며, 해당 프로젝트의 코드·에셋·브랜딩을 포함하지 않습니다.
[참고 프로젝트의 라이선스](https://github.com/paulallington/Claudes/blob/v1.9.82/LICENSE)를 확인할 수 있습니다.

장기 목표는 OpenDIY Desktop으로 ChatGPT 데스크톱 앱을 대체하는 것입니다.
ChatGPT·Claude 데스크톱의 기능과 사용성을 참고하되, 현재 기능이 동등하다는 뜻은 아닙니다.
