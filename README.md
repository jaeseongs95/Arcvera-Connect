# OpenDIY Desktop

A Windows workspace for running Codex CLI sessions side by side. Group conversations
by project, arrange terminals in a resizable grid and return to saved work.

**English** | [한국어](README.ko.md)

[Download](https://github.com/jaeseongs95/opendiy-desktop/releases/latest) ·
[Quick start](#quick-start) · [User guide](docs/user-guide.md) ·
[Development](docs/development.md)

![Switching projects and running sessions in OpenDIY Desktop](docs/loading-demo.gif)

*Recorded during real use on 2026-10-30, at the original playback speed.
This is a usage example, not a performance comparison or a recording of the latest release.*

## Supported Codex runtimes

Desktop and Codex are installed separately. The documented runtime baseline for
Desktop **1.1.1** is:

| Runtime | Support scope |
| --- | --- |
| [OpenDIY Codex](https://github.com/jaeseongs95/opendiy-codex) R36 CLI with its R36 app-server | Basic terminal and session workflow, plus extensions when their required capabilities are available. Earlier OpenDIY builds, including R28, are outside the support policy. |
| [Official Codex CLI](https://github.com/openai/codex) 0.166.0 | Basic terminal and session workflow. OpenDIY extensions are not assumed to be available. |

Extension controls depend on the actual support provided by the selected CLI and
connected server, as well as connection and task state. A version number alone
does not guarantee a feature. See [runtime selection and server transitions](docs/user-guide.md#runtime).

## Quick start

1. **Install Codex and sign in.** Use one of the runtimes above. Desktop packages
   do not include or download Codex.
2. **Install or extract Desktop.** Download the Windows x64 installer or portable
   ZIP from [Releases](https://github.com/jaeseongs95/opendiy-desktop/releases/latest).
   Windows and WebView2 are required; builds are unsigned. For the portable edition,
   extract the **whole ZIP** and keep `opendiy-desktop-helper.exe` beside
   `opendiy-desktop.exe`. Check the download against the release's `SHA256SUMS.txt`,
   then launch the installed app or `opendiy-desktop.exe`.
3. **Select your CLI.** Open **⚙ Settings → Executable settings** and choose the
   native `codex.exe` or installed `opendiy-codex-launcher.exe`. A server executable
   is selected automatically; specifying one separately is optional. Changing
   these paths does not replace a running shared server or restart open terminals.
4. **Open a project and a session.** Choose **Import project**, select an existing
   folder, then resume a conversation or create a new session. Use the CLI's own
   interface for model, sign-in and permission prompts. **Shift+Enter** inserts a
   line break in its prompt.

The interface defaults to Korean. Choose **한국어 / English** under
**Settings → Language** to change the app and tray language. CLI output and Windows
system labels keep their own language.

## Find your workflow

| I want to… | Guide |
| --- | --- |
| Group sessions, reorder projects or switch the grid | [Projects and terminals](docs/user-guide.md#projects) |
| Resume a saved conversation or restart one session | [History, restore and restart](docs/user-guide.md#restore) |
| Use conversation view and answer questions or approvals | [Conversation and question inbox](docs/user-guide.md#conversation) |
| Manage plugins, marketplaces or skills | [Plugins and skills](docs/user-guide.md#extensions) |
| Inspect and control direct subagents | [Subagents](docs/user-guide.md#subagents) |
| Inspect context usage, compact or schedule work | [Context](docs/user-guide.md#context) · [Schedules](docs/user-guide.md#schedules) |
| Pair a phone with a running session | [Mobile remote control](docs/user-guide.md#mobile) |
| Check weekly usage or stored attachments | [Usage](docs/user-guide.md#usage) · [Storage](docs/user-guide.md#storage) |

## Closing, data and limitations

- **Closing the window hides it to the tray.** Use **Exit app** for a complete exit
  and confirmed cleanup of app-owned processes. Restoring later starts new processes
  against saved conversation IDs; it does not revive old process IDs or resend input.
- Codex owns authentication, configuration and conversation history. Desktop stores
  layout, projects, session metadata and preferences in its own SQLite database;
  it does not copy Codex authentication files or terminal transcripts into that database.
  Submitted pasted images are retained separately when history may reference them.
- Display and input buffers are bounded. This does not truncate model context or
  establish a limit for the CLI process's memory use.
- Physical phone pairing/control and long-duration leak testing remain unvalidated.
  Check each release's notes for the tests actually run and their limitations.

See the [user guide](docs/user-guide.md) for ownership, retry and recovery behavior.

## Development and verification

Built with Tauri 2, Rust/portable-pty, TypeScript, Vite and xterm.js.
The [development guide](docs/development.md) covers prerequisites, build commands,
packaging and diagnostic modes. Windows CI checks and packages the application;
build success alone does not prove GUI behavior or complete CLI compatibility.

Historical observations and their scope are linked in the
[verification notes](docs/development.md#verification). Please include the Desktop
version, selected CLI/server versions, reproduction steps and expected/actual
behavior in a [bug report](https://github.com/jaeseongs95/opendiy-desktop/issues).
Do not attach credentials or private conversation logs.

## License and direction

An independent [MIT-licensed](LICENSE) implementation. Claudes' multi-terminal
workflow was a product reference; its code, assets and branding are not included.
See its [reference license](https://github.com/paulallington/Claudes/blob/v1.9.82/LICENSE).

The long-term goal is to replace the ChatGPT desktop app with OpenDIY Desktop,
learning from ChatGPT and Claude desktop features and usability. That is future
direction, not a claim of current feature parity.
