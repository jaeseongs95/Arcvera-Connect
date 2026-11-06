# Development and verification

[English home](../README.md) · [한국어 처음으로](../README.ko.md) ·
[User guide](user-guide.md) · [사용 가이드](user-guide.ko.md)

Read [AGENTS.md](../AGENTS.md) before changing the repository.

## Build on Windows

Requires Node.js 24, Rust stable, MSVC build tools and WebView2 on Windows.

```powershell
npm ci
npm test
npm run build
node scripts/notices.mjs
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run tauri -- dev
```

Package the desktop bundle:

```powershell
npm run tauri -- build --config src-tauri/tauri.bundle.conf.json --bundles nsis
```

Desktop 1.2.0 launches work processes directly in Windows Jobs. There is no
separate Desktop helper binary to build or distribute. Codex and shell processes
remain separate from Desktop. The patched portable-pty dependency is kept under
`src-tauri/vendor/portable-pty`.

If Unicode workspace paths cause native tool failures, build in a separate
checkout under `D:/codex/build/opendiy-desktop`.
Generate third-party notices before native compilation; they are bundled
with the installer and distributed alongside the portable executable.

Use `D:/codex/build/<project-task>/` for local build copies, dependencies and
intermediate output. Check available disk space and reusable copies first. Preserve
source and required evidence, then remove only your own unused temporary artifacts.

The [Windows workflow](../.github/workflows/windows.yml) defines the full
test/package sequence. Keep vendor protocols inside the Codex adapter and use
runtime-reported models and capabilities. Preserve authentication, configuration,
external conversations and in-progress work. UI limits must not truncate model context.

<a id="verification"></a>

## Validation and releases

Windows CI runs frontend checks, Rust tests and packaging. Releases include
an unsigned Windows x64 portable ZIP, NSIS installer and SHA-256 sums.
Unsigned builds may trigger Windows reputation warnings.

Actual test results and remaining limits belong in release notes; a successful
build is not evidence of long-duration stability or complete CLI compatibility.

The packaged executable provides separate diagnostic modes:

```powershell
opendiy-desktop.exe --self-test --duration-seconds 60 --report D:/codex/build/pty-result.json
opendiy-desktop.exe --codex-smoke --sessions 2 --cwd D:/projects/already-trusted --report D:/codex/build/codex-result.json
```

The first exercises real native PTYs with local shell fixtures, including
2/8/16-session isolation, stale-generation rejection, bounded output,
cancellation and 100 create/stop cycles followed by eight sustained PTYs.
Use `--duration-seconds 14400` for four hours of sustained PTY activity.
The second starts actual Codex servers and remote TUIs without submitting
model prompts or answering trust/approval dialogs. `--cwd` must name an existing,
already trusted directory; the probe reads its startup context and does not
write project files. Keep the report directory outside that project. Omitting
`--cwd` creates fresh directories beside the report, which may stop at Codex's
normal trust screen. The probe
requires observed thread IDs and live statuses, and records terminal hashes
rather than transcripts. Neither mode proves physical IME or GUI behavior.

Before testing, specify each requirement's input, preconditions, procedure,
expected result and pass/fail rule. Record actual results against the exact
candidate. Keep fixture, source inspection, CI, native diagnostics and real GUI
interaction evidence distinct.

The feature-specific cases document required behavior and the scope of earlier
checks: [hook management](hooks-test-cases.md),
[session context settings](session-context-test-cases.md),
[plugin management](plugin-manager-test-cases.md),
[project-switch scrolling](project-switch-scroll-test-cases.md) and
[process ownership](process-consolidation-test-cases.md).
Results for another commit or executable do not establish GUI success for the
1.2.0 integration candidate. Record its own validation results in its release notes.

The [historical validation record](validation.md) describes only the commits and
tests named there. The [Task Manager capture](real-world-task-manager.png)
accompanied the 2026-10-30 usage recording. It includes multiple application, CLI
and WebView2 processes; it does not isolate Desktop's total memory use or establish
a current performance comparison. Neither this image nor the README recording
establishes long-duration stability.

## Contributions and licensing

Use a scoped branch and preserve unrelated changes. Report the tests actually run,
their results and remaining limits. Keep release notes tied to exact artifacts.
Never copy Claudes source, assets or UI text. This repository is independently
[MIT-licensed](../LICENSE); packages must retain their third-party notices.
