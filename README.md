# OpenDIY Desktop

**Fast loading, shown in real use**

A real-world recording showing the faster loading experienced compared with the ChatGPT desktop app.
This approximately 6.5-second recording shows project switching and multiple running sessions.

![Fast project and session loading in real use, at the original playback speed](docs/loading-demo.gif)

*Recorded during real use on 2026-10-30 · original playback speed · no speed-up*

![Windows Task Manager during real use](docs/real-world-task-manager.png)

*Task Manager from the same real-world setup, with OpenDIY Desktop, CLI and WebView2 processes running together.*

**English** | [한국어](README.ko.md)

A Windows desktop grid for running coding-agent CLI sessions side by side.

The Codex adapter supports [OpenDIY Codex](https://github.com/jaeseongs95/opendiy-codex),
the selected runtime for this project, and compatible official Codex CLI versions. Arrange terminals in a
resizable grid, group them by working directory, search terminal output and
enter text directly in each terminal.

OpenDIY Desktop is an independent MIT implementation. It does not include code,
assets or branding from Claudes. That project's multi-terminal workflow was
a product reference; its source-available license does not permit unapproved
modification or redistribution. See the [reference license](https://github.com/paulallington/Claudes/blob/v1.9.82/LICENSE).

## Language

Open **⚙ Settings** in the upper-right corner and select **한국어** or **English**
under **Language**.
Changes apply immediately to the app interface and native tray/chooser labels,
and the desktop app saves the selection in its own SQLite settings for the next launch.
The default is Korean. Session titles, paths, conversations and terminal output
stay exactly as provided. CLI diagnostics and Windows system buttons can remain
in their original language; the app does not change the CLI or OS locale.

## Running

Download the portable ZIP or per-user installer from
[Releases](https://github.com/jaeseongs95/opendiy-desktop/releases). Windows x64 and
WebView2 are required. The application is unsigned.
Extract the whole portable ZIP and run `opendiy-desktop.exe`. Keep
`opendiy-desktop-helper.exe` beside it: Windows requires a console process for the
terminal side while the main application uses a normal desktop window.

Install and sign in to OpenDIY Codex or a compatible official Codex CLI first. Desktop
packages do not bundle a CLI binary, and the app does not download one. Open **⚙ Settings**
in the upper-right corner, choose **Executable settings** and select its native `codex.exe`;
the app saves that path for future starts
and history queries. The screen shows the saved path, resolved executable and
where it came from. Cancelling the chooser keeps the previous setting.
Changing it leaves running terminals alone.

In v1.0.0, you can also select the installed `opendiy-codex-launcher.exe`.
Desktop resolves its selected package for each new request and uses that package’s
CLI and automatic server candidate together. Open sessions keep their admitted
executable paths. A manually selected server stays selected; a failed launcher
lookup is reported without falling back to another executable.

Choose **Use automatic discovery** to clear the app's saved override. Resolution then uses
`AGENT_GRID_CODEX`, if set, followed by the native executable on `PATH`.
The saved app preference has priority over both. Missing or invalid executables
are reported explicitly instead of silently using a different program.
The CLI must support `--remote` and either the shared daemon/proxy commands or
authenticated app-server WebSockets. Supported shared connections fail explicitly
when unavailable; they are never silently replaced with a separate server.

Choose **Import project** to select an existing local folder in the native Windows
folder chooser (`IFileOpenDialog`). Imported projects remain in the sidebar after
their terminals stop. The session browser opens for that project; choose an existing
conversation or start a new session with its working directory already filled in.

Use **New project** to create a named session group with an optional existing default
working folder; this does not create a disk folder. Open **⋯** beside a project to
rename it, mark it as a favorite or delete it. Deletion removes only the app's project
metadata and moves its sessions to **Unassigned**. It preserves running terminals,
original conversations and disk folders. **Move to project** on a session changes
its group without restarting its terminal or changing its actual working directory.

Use the project tabs above the grid, or click a project in the sidebar, to
view that project's sessions. **All** shows every session. Switching tabs keeps
all terminals running and retains their output. Switching projects or moving a session
shows its latest terminal output; keyboard session shortcuts apply only to the
visible project. When the selected project has
a default folder, new sessions and the session browser start with that directory.

**Load sessions** opens a two-pane popup. Search session titles and filter by
project on the left; inspect dates, the conversation ID and recent messages on
the right before resuming. Already open conversations focus their existing
terminal. Browsing uses read-only requests through a short-lived owned server,
so it does not require an existing desktop daemon. Recent messages are fetched
in bounded pages and are not stored in OpenDIY Desktop's database.

Use **New session** to enter a directory directly. Use the official TUI to choose
a model, sign in or answer permission prompts. Enter text directly in the terminal
you want to control. Use **Shift+Enter** to insert a line break in the CLI prompt.

Drag a registered project in the left list to change its position, or open its **⋯** menu and use **Move up / Move down**. The saved order is shared by the project list, tabs and destination picker and survives app restarts. Favorites remain grouped at the top; projects move within their own group. Reordering changes only the list, and a failed save leaves the displayed order unchanged.

## Restarting and restoring sessions

After a complete exit, the app restores the workspace that was open at shutdown.
Previously running sessions reconnect using their saved conversation IDs, keeping
their titles, projects, grid order and sizes. It never resends previous input or
loads an entire saved terminal transcript. Individually removed sessions stay closed.

Sessions without conversation IDs, stopped sessions and entries saved by older
versions without a restart intention never silently create new conversations.
Unconnected entries remain available in the saved-session list for manual retry;
a partial connection failure does not erase the remaining saved entries.
Hiding the window to the tray and reopening it keeps the existing terminals running.

Saved entries that are not running do not consume a concurrent-terminal slot.
The existing resource limit of 32 terminals remains; automatic restoration leaves
additional entries in the saved list when those terminal slots are full.

Use **Restart session** (the circular arrow in the session header) to stop that session's owned process and reconnect the same conversation. The conversation ID, project and grid position are preserved. Running work is interrupted after confirmation. Finish or remove unsent drafts and attachments before restarting. The control stays unavailable until the conversation ID is known; failed cleanup never starts another process. A failed reconnect leaves the original conversation available for retry.

## Subagent management

Use **Manage subagents** in a running session header to view its direct subagents.
Search the current page on the left and inspect status, role, model and reasoning
effort on the right. Send instructions, interrupt the observed turn, close an
agent or resume it. Closing requires confirmation, also stops its descendants
and preserves saved conversations.

A compatible CLI advertising `supportsSubagentManagement` is required. Unsupported
runtimes receive no management requests. Lists use pages of up to 100 metadata
entries, refresh every five seconds while the popup is visible and never fetch
conversation bodies. An uncertain mutation is reconciled by its original request
ID rather than automatically sent again.

The connected shared server must also support this feature, even when the selected
CLI is newer. Selecting an executable or restarting the desktop app does not update
that server. A server update can interrupt running work; finish that work before
following the compatible package update instructions. The app never performs this
update automatically.

## Plugins and skills

Open **⚙ Settings** in the upper-right corner, then **Plugins & skills**.
The popup uses the executable selected
in **Executable settings**, and shows that executable and the selected project.
Search installed/available plugins and skills, install/remove or enable/disable
plugins, manage marketplace sources, and enable/disable skills. Import an existing
skill folder containing `SKILL.md` into the selected project or your user skill
folder using the native Windows folder chooser. The review screen shows the exact
target and scope before applying a change.
Existing destination folders are never overwritten; links and oversized imports
are rejected. Errors and unsupported CLI capabilities remain visible.

Plugin installation and marketplace changes use the CLI's own commands; skill
and setting changes use its app-server APIs. Existing CLI authentication and
configuration remain owned by that CLI. Changes are read back after applying.
Start a new session to use changed extensions; running terminals are not restarted.

## Runtime combinations and verification status

Version numbers alone do not guarantee compatibility. The selected CLI and an already running shared server may come from different builds. Check the actual server declarations together with the scope below.

In **Settings → Executable settings**, choose the CLI and app-server executable separately. Automatic server selection uses the CLI's sibling `codex-app-server.exe`, or the same CLI's built-in server when that sibling is absent. Changing this selection does not replace an existing shared server. Startup checks the full CLI, selected-server, managed-package and running-server versions before restoring sessions; a mismatch opens a recovery path to these settings.

**Check server versions → Align versions** reviews the complete package and requires confirmation that work in other Codex windows and on mobile has finished. The CLI must declare non-forcing update support; older CLIs cannot use this action. The managed server runs through its own managed CLI path, which can differ from the selected standalone server path. Only a confirmed successful transition and connection check resumes automatic restoration. An uncertain result blocks automatic reconnection and retry; inspect the server again before deliberately retrying. A submitted shutdown request cannot be canceled and may finish later. This does not promise that every updater process exits.

| Desktop | Codex CLI | App server | Actual integration scope and limitations |
| --- | --- | --- | --- |
| v0.6.0 release candidate, [deba0725](https://github.com/jaeseongs95/opendiy-desktop/commit/deba0725ea7420e84e95ab569c9a3534e67fa2c1) | Released R30, `1cacc86` | Released R30 artifact: `86cf681`; identity with the server in the limited test is unconfirmed | Four native steps checked only the unsupported-subagent-management boundary (run `b807b535`). This is not a complete integration pass for the combination. |
| Same v0.6.0 release candidate | R31 development candidate, `e8a1d84` | Same R31 development candidate; final package identity pending | Historical protocol comparison only. Final executable joint tests did not run; R31 is excluded from release and installation. |
| Follow-up branch, [6929409](https://github.com/jaeseongs95/opendiy-desktop/commit/69294093d92ccdb859280009c5a2d340d54f0372) | Same R31 development candidate | Same R31 development candidate | Passed 70 affected browser tests, 296 CI browser tests, 238 Rust tests, a native PTY test and a separate code review. Joint tests with the actual CLI/server combination did not run. Producer inspection later confirmed that daemon version internally initializes a connection, so these tests do not establish the no-initialization boundary. |
| Follow-up implementation, [2fefa895](https://github.com/jaeseongs95/opendiy-desktop/commit/2fefa895d2a2db9c3923bb79cf8dd19b8b4b11ca) | New R31 candidate reported by its maintainer, `1cd3bbff` | Final package handoff pending; executable identities and matching source unverified | [Desktop-only automated checks](https://github.com/jaeseongs95/opendiy-desktop/actions/runs/41270806309) passed 308 browser tests, 242 Rust tests and one native PTY test. These are not joint R31 tests. R31 is excluded from release and installation; final joint tests will use R32. |
| Same follow-up implementation | R32 candidate before redesign reported by its maintainer, `2f42356a` | Not frozen for final distribution; no executable pairing | The earlier `b0d8fa11` entry is historical review context. Neither a fresh contract comparison nor joint tests have run with this new candidate; this is not a verified combination. |

The table preserves earlier candidate checks. [Desktop v0.6.0](https://github.com/jaeseongs95/opendiy-desktop/releases/tag/v0.6.0) and [Codex R32](https://github.com/jaeseongs95/opendiy-codex/releases/tag/v0.166.0-r32.20261101) have since been released. Their installed-path joint checks passed 17 steps; compaction, child mutations and materialized history paging remained untested. R31 was excluded from release and installation. R32 does not support the new non-forcing transition action; a compatible CLI package is required. Updating a server is separate from choosing an executable and can affect other Codex clients.

## Runtime compatibility and attachment storage

Use **Settings → Executable settings → Check compatibility** to read only the selected executable version and help. This check opens no server connection and never calls `daemon version`. Server versions and feature declarations come only from existing sessions with the same executable and socket; they do not recheck current execution or connectivity. Unobserved versions and support, next-start selection that cannot be checked safely, and the actual server executable path remain unknown. Compaction also remains unknown in this check. Checking does not resume a session or install, start or replace a server. Each feature separately checks its connection, permissions and task state.

Use **Settings → Attachment storage** to inspect app-owned image usage and limits, distinguishing current-process unsent drafts, retained images and other files such as those from previous runs. Original local files are excluded. Remove draft attachments in their original session to free space. Submitted images, uncertain sends and files with unknown ownership are preserved.

## Mobile remote control

Open **⚙ Settings** in the upper-right corner, then **Mobile remote control**,
select a running session and read its status. Enable
remote control, refresh until the remote service is connected, then create a pairing
code to enter in mobile Codex. A connected remote service means the session server
has connected to the relay; it does not confirm that a phone is paired.

The selected CLI must support the remote-control app-server APIs and be signed
in with a ChatGPT account. API key authentication is unsupported. Shared-capable
CLIs connect the terminal, status observer and mobile controls to the same existing
daemon through its default proxy. Shared enable, disable and pairing affect all
conversations on that server. At startup, the app reuses a running daemon or starts
the installed daemon, then verifies its connection before restoring sessions. A
failed start leaves saved sessions available for retry. The app does not install,
replace or stop the shared daemon.
Automatic startup requires the CLI's `app-server daemon start --existing-installation`
option. With older CLIs, start the shared server before opening the app.

For older CLIs without shared commands, the app-owned server remains available.
Its mobile mutations require `--remote-control-client-name` to avoid replacing
other registrations. Actions stay disabled until a status response confirms that
mutations are allowed. The popup explains the connection scope and limitations.

Stopping a shared session pins its original turn ID before closing its terminal;
it never retargets a later mobile turn. Unconfirmed stops remain unknown and are
not automatically resent. The shared daemon and registration survive app exit.
If normal exit fails because a remote stop is unconfirmed, a separate **Close app
with unconfirmed remote stop** action becomes available only after all local resources have
been reaped. Remote work may continue. This action neither marks it stopped nor
resends the stop request.
Pairing codes are not saved. Physical phone pairing and control remain unvalidated.
Shared connections require the companion CLI fixes for newly started empty threads
and default-proxy protection. The original R28 binary has remote APIs but lacks
these fixes. Check the release notes for the compatible executable and checksum.
A history-unavailable warning preserves live session input; it does not mean that
all previous messages have loaded.

## Weekly usage

The lower-left indicator reads the selected CLI account's representative weekly
rate-limit window: an explicit 10,080-minute window, its used percentage and reset
time when provided. It is account usage, not a total calculated from this app's
sessions. Missing weekly data and read failures are shown separately and never
treated as 0%. Automatic reads run 60 seconds after the previous request settles and pause while
the window is hidden. Refresh reads immediately, with a five-second manual limit and one request
at a time. A failed refresh keeps the last confirmed value and its timestamp. Technical errors
are not shown in the usage panel. External session records are available in Settings.

## Memory and history

History is loaded only on request: up to 50 sessions or conversation items per
page. The popup retains at most 250 session rows and 100 preview messages (128 KiB
of preview text), dropping older displayed pages as more are requested. Select a
session again to return to recent messages. Closing the popup releases its rows,
preview and selection; conversation bodies are not copied into the app database.
The extensions popup initially renders 50 rows, keeps at most 250 row elements,
and releases fetched data on close.
Terminal input also has bounded admission: at most 128 accepted requests and 256 KiB
including the current write, with the native 64 KiB per-request ceiling. Input pauses
under pressure and resumes after draining; oversized or unaccepted input is reported.
Resize keeps one current request and the latest unsent size. Disposing a terminal
releases queued input and geometry. Restored sessions initially load metadata only.
OpenDIY Codex R28 also bounds its display history to 30 turns, 400 items and 8 MiB
of retained logical source per display budget. Older sections are fetched on demand;
distant display references are released when their independent operations finish.
These budgets do not limit the entire process, durable history or model context.
Legacy history still uses the official full-read fallback, so its initial load can
exceed the display budget. Other selected CLIs retain their own history behavior.
These bounds and lifecycle tests are not a claim of a completed long-duration leak test.
Each session retains at most 1,024 answered or resolved server-request IDs. Exceeding this
limit blocks conversation observation and input handoff, rather than forgetting resolved requests
that could arrive again in a delayed replay. Original work and conversation data are preserved.

Existing saved settings and projects from Agent Grid are preserved. The longer-term
product direction is to learn from ChatGPT and Claude desktop workflows; the full
benchmark and broader feature migration are future work.

## Development

Requires Node.js 24, Rust stable, MSVC build tools and WebView2 on Windows.

```powershell
npm ci
npm test
npm run build
node scripts/notices.mjs
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run tauri -- dev
```

Package the console helper before the desktop bundle:

```powershell
cargo build --locked --manifest-path src-tauri/Cargo.toml --release --bin opendiy-desktop-helper
npm run tauri -- build --config src-tauri/tauri.bundle.conf.json --bundles nsis
```
If Unicode workspace paths cause native tool failures, build in a separate
checkout under `D:/codex/build/opendiy-desktop`.
Generate third-party notices before native compilation; they are bundled
with the installer and distributed alongside the portable executable.

## Codex

Install and sign in to OpenDIY Codex or a compatible official Codex CLI separately. OpenDIY Desktop uses
your existing login and honors `CODEX_HOME`. It never installs or updates the
CLI and never changes its global permission settings. Model selection stays
in Codex's own `/model` interface.

Managed sessions use a normal Codex terminal with an explicit conversation ID.
Shared-capable CLIs use their existing daemon; older CLIs retain an owned
authenticated loopback server. External sessions are listed read-only through
the official daemon proxy. An unavailable shared server or unknown status is
reported explicitly, without starting another server.

Closing the window hides it to the tray. Complete exit terminates owned
processes after confirmation. Restoring after a complete exit starts new
processes against the saved conversation ID, rather than reviving an old PID.
Authentication tokens are not stored in the application database.
Layout, session metadata, imported projects, the executable choice and language
are stored in the app's own SQLite database. Browser previews use WebView local storage.
Terminal transcripts and Codex authentication files are not copied there.

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

## Conversation view and question inbox

Use a session card's **Conversation / Terminal** button to switch views of the same thread.
The terminal grid remains available. Switching views does not create a thread or resend input.
Conversation view reads structured runtime history in pages and follows recent events; it does
not parse terminal text. Earlier pages and large originals are fetched on demand.

Conversation view requires a runtime supporting passive subscriptions and atomic idle user input.
Selecting a newer executable does not automatically upgrade an already running shared server.
Conversation view checks the connected server; the app never stops or replaces an existing daemon.
Older servers show a capability limitation; the app does not fall back to operations that can trigger
queued work or merge a new message into an active turn. Terminal view remains available. Weekly
usage also reads only through an existing shared server; unavailable reads preserve the last
confirmed value and observation time.

Displayed-section search checks only the messages and previews already shown, without loading the full conversation. Move between matching messages or return to the latest section. Message copy includes only the displayed content; manually load another slice of large content to search or copy it.

The composer supports multiline text, Korean composition, pasted images and native file selection.
Ordinary files are local references, not the ChatGPT document upload service. Model and reasoning
controls use runtime-reported settings and supported choices; unavailable values remain unknown.
Unsupported runtime features are reported explicitly. An uncertain send is never retried automatically
and its draft is preserved.
An explicit switch to Terminal can hand input back while ordinary unanswered requests remain.
Responses already in progress, uncertain sends and unverified request ownership block the switch
and preserve the conversation view and draft. Automatic hiding or cleanup never performs this handoff.
If live events arrive during a history query, a stale response is discarded with a reload notice.
Unavailable history is never treated as an empty or idle conversation.

The upper-right **Question inbox** shows the count of confirmed unanswered questions and approvals.
Opening the inbox does not reset the count; server-confirmed resolution removes an entry. Questions
collected from terminal sessions are answered in the original session. Terminal
waiting states whose request details are unavailable are listed separately with a link to the original
session and are not counted as confirmed questions.

Sent pasted images remain in app-owned storage because resumed history can reference them.
Unsent temporary files are cleaned up; original user files are never deleted. Exceeding the storage
budget rejects new attachments rather than automatically deleting earlier attachments.

## Session context controls

Each session header has a context meter and a manual compaction button. The meter uses
the runtime's latest model response token usage divided by its reported context window,
not cumulative billing usage or the terminal transcript size. Hover for the token counts;
click to refresh. Missing or stale measurements display an em dash. Visible cards read one
bounded local snapshot every two seconds; hidden cards stop these reads.

Manual compaction requires an idle, connected original thread with no pending approvals
or unknown request result. The app must use an atomic idle-only runtime operation; it
never falls back to the legacy compaction operation that can replace an active task.
Unsupported runtimes keep the button unavailable. Acceptance is not completion, and an
unknown result is never automatically retried. Drafts and original conversations are preserved.

## Session scheduled jobs

The clock icon in a session header opens schedules owned by that session’s CLI. The dialog supports recurring intervals, a one-time local execution time, listing, adding, pausing, resuming, removing, and requesting cancellation of the current occurrence. Schedules end when the owning CLI exits; no separate operating-system schedules are created.

Removing or pausing a schedule does not interrupt an accepted run. Cancelling an occurrence targets only the turn owned by that schedule and preserves recurring schedules. Unknown mutation results are never retried automatically and block further changes until reconciled. Runtimes without structured schedule control show an unsupported state and disable mutations.
