# OpenDIY Desktop user guide

[Home](../README.md) · [한국어](user-guide.ko.md) · [Development](development.md)

This guide describes Desktop 1.2.0. Start with the [installation and support overview](../README.md).

<a id="runtime"></a>

## Executables and shared servers

Download the portable ZIP or per-user installer from
[Releases](https://github.com/jaeseongs95/opendiy-desktop/releases). Windows x64 and
WebView2 are required. The application is unsigned.
Extract the whole portable ZIP and run `opendiy-desktop.exe`. Desktop directly
launches its work processes in Windows Jobs; no separate Desktop helper executable
is required. Codex, shell and WebView2 processes still run separately.

Install and sign in to OpenDIY Codex or a compatible official Codex CLI first. Desktop
packages do not bundle a CLI binary, and the app does not download one. Open **⚙ Settings**
in the upper-right corner, choose **Executable settings** and select its native `codex.exe`;
the app saves that path for future starts
and history queries. The screen shows the saved path, resolved executable and
where it came from. Cancelling the chooser keeps the previous setting.
Changing it leaves running terminals alone.

You can also select the installed `opendiy-codex-launcher.exe`.
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

**Desktop 1.2.0 OpenDIY runtime baseline: OpenDIY Codex R36 CLI with its R36 app-server.** Earlier OpenDIY builds, including R28, are outside the support policy. Use the matching CLI/server package. Official Codex CLI **0.166.0** is supported separately for the basic terminal and session workflow; Extensions are enabled only when the selected CLI and connected server provide the support required by each feature. Schedule control checks the CLI declaration separately from server capabilities.

Existing daemon data and running work are preserved. Selecting an executable does not authorize replacing or stopping another server. Version numbers alone do not establish feature support; the app checks actual declarations.

In **Settings → Executable settings**, choose the CLI; specifying an app-server separately is optional. Automatic server selection uses the CLI's sibling `codex-app-server.exe`, or the same CLI's built-in server when that sibling is absent. Changing this selection does not replace an existing shared server. Different version numbers alone do not block startup or restoration; connection failures explain their cause and recovery options. A first installation uses the selected CLI's preparation flow and does not automatically replace an existing server.

Structured conversation, subagent and manual-compaction controls follow each feature's actual support declaration. The schedule button remains available to manage Desktop definitions; CLI registration and execution controls require runtime support and connection. Support is separate from connection and task readiness. If conversation attachment fails, the app returns to the terminal only after safely releasing input ownership. An uncertain release preserves the draft and input ownership.

**Check server versions → Align server version…** reviews the complete package and requires confirmation that work in other Codex windows and on mobile has finished. The CLI must declare non-forcing update support; runtimes without that declaration cannot use this action. The managed server runs through its own managed CLI path, which can differ from the selected standalone server path. Only a confirmed successful transition and connection check resumes automatic restoration. An uncertain result blocks automatic reconnection and retry; inspect the server again before deliberately retrying. A submitted shutdown request cannot be canceled and may finish later. This does not promise that every updater process exits.

Historical release-combination checks remain in the Git history; they do not establish support for this release.

Shared lifecycle preparation checks `--existing-installation` and `--first-installation`; the presence of a `daemon` command alone is insufficient.

<a id="projects"></a>

## Projects and terminals

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

Switching to another project or **All** moves the visible terminals and conversation
views to their latest output or message, including cards that were already visible.
Selecting the same project again preserves your reading position. Conversation
drafts are preserved; when switching through project tabs, focus stays on the selected tab.

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

<a id="restore"></a>

## History, restoration and restart

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

<a id="conversation"></a>

## Conversation view and question inbox

Use a session card's **Conversation / Terminal** button to switch views of the same thread.
The terminal grid remains available. Switching views does not create a thread or resend input.
Conversation view reads structured runtime history in pages and follows recent events; it does
not parse terminal text. Earlier pages and large originals are fetched on demand.

Conversation view requires a runtime supporting passive subscriptions and atomic idle user input.
Selecting a newer executable does not automatically upgrade an already running shared server.
Conversation view checks the connected server and does not itself stop or replace it.
Use the separately confirmed version transition in executable settings when needed.
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
Opening the inbox does not reset the count; server-confirmed resolution removes an entry. Asynchronous questions
collected from terminal sessions can be answered in the inbox without switching the terminal view.
Check the original session when the current question or connection cannot be verified, or when a
regular approval request belongs to another connection. Terminal
waiting states whose request details are unavailable are listed separately with a link to the original
session and are not counted as confirmed questions.

Sent pasted images remain in app-owned storage because resumed history can reference them.
Unsent temporary files are cleaned up; original user files are never deleted. Exceeding the storage
budget rejects new attachments rather than automatically deleting earlier attachments.

<a id="extensions"></a>

## Plugins and skills

Open **⚙ Settings** in the upper-right corner, then **Plugins, skills & hooks**.
The popup uses the executable selected
in **Executable settings**, and shows that executable and the selected project.
The default plugin view lists installed plugins, with enable/disable and removal
controls. To find a new plugin, choose **Add a plugin**, enter at least two characters
of its name and choose **Find**. Opening this view does not fetch the full catalog;
an explicit search queries it and displays matching, uninstalled plugins. Review and
confirm installation; after a confirmed install, the dialog returns to installed
plugins. Search or installation failures remain visible.

You can also manage marketplace sources and enable/disable skills. Import an existing
skill folder containing `SKILL.md` into the selected project or your user skill
folder using the native Windows folder chooser. The review screen shows the exact
target and scope before applying a change.
Existing destination folders are never overwritten; links and oversized imports
are rejected. Errors and unsupported CLI capabilities remain visible.

Plugin installation and marketplace changes use the CLI's own commands; skill
and setting changes use its app-server APIs. Existing CLI authentication and
configuration remain owned by that CLI. Changes are read back after applying.
Start a new session to use changed extensions; running terminals are not restarted.

<a id="hooks"></a>

## Hooks

Open **⚙ Settings → Plugins, skills & hooks → Hooks**. The list uses the selected
CLI and project. Select a hook to inspect its event, source, handler details,
activation and trust status. Unsupported APIs, configuration errors and unavailable
lists are reported separately from an empty list.

Review the exact target before enabling, disabling or trusting a hook. Changes are
saved to the selected CLI's user configuration and can affect other projects. The
app checks the hook's current content fingerprint and configuration version before
writing, then reads its state back. Changed definitions, policy-managed hooks or
configuration conflicts are not overwritten. A failed or unconfirmed change is not
automatically retried.

New trust approval is available only for command hooks whose executable content can
be reviewed here. MCP, prompt and agent hooks omit part of that definition from the
available metadata, so this screen cannot grant them new trust. You can disable
untrusted hooks and toggle already trusted hooks where policy permits. Trusting a
command hook approves its current fingerprint without enabling it automatically.
The dialog does not create hook definitions or run a hook as a test. Check changed
configuration in a new session; a successful state readback does not confirm that
every running conversation has reloaded it.

<a id="subagents"></a>

## Subagents

Use **Manage subagents** in a running session header to view its direct subagents.
Search the current page on the left and inspect status, role, model and reasoning
effort on the right. Send instructions, interrupt the observed turn, close an
agent or resume it. Closing requires confirmation, also stops its descendants
and preserves saved conversations.

The connected server must advertise `supportsSubagentManagement`. Unsupported
runtimes receive no management requests. Lists use pages of up to 100 metadata
entries, refresh every five seconds while the popup is visible and never fetch
conversation bodies. An uncertain mutation is reconciled by its original request
ID rather than automatically sent again.

The connected shared server must also support this feature, even when the selected
CLI is newer. Selecting an executable or restarting the desktop app does not update
that server. A server update can interrupt running work; finish that work before
following the compatible package update instructions. The app never performs this
update automatically.

<a id="context"></a>

## Context and compaction

Each session header has a context meter and a manual compaction button. The meter uses
the runtime's latest model response token usage divided by its reported context window,
not cumulative billing usage or the terminal transcript size. Hover for the token counts;
click to refresh and, when supported, open settings for that session. Missing or stale measurements display an em dash. Visible cards read one
bounded local snapshot every two seconds; hidden cards stop these reads.

When the server confirms support, clicking the usage icon opens **Session context
size** for that card's conversation. Enter a positive whole number of tokens and
choose **Apply**, or choose **Restore default** to remove that session's override.
The dialog shows the requested size and the effective budget separately; model
limits can make the effective budget smaller. Changes apply to the next turn of
that session and do not change other sessions or global defaults, or increase the
model's supported limit. Unsupported or unconfirmed responses leave the size editor
unavailable while usage refresh remains available.

A change is confirmed only by a matching server acknowledgement. Closing the dialog
does not cancel an already submitted request. Unknown results are not resent
automatically; click the icon to check again. If the server cannot confirm the
original requested value, further size changes remain blocked for that session.
Do not assume this override persists through restart or resume without runtime
confirmation.

The compaction button only requests compaction; it preserves the current terminal/conversation view and input ownership.
Manual compaction requires an idle, connected original thread with no pending approvals
or unknown request result. The app must use an atomic idle-only runtime operation; it
never falls back to the legacy compaction operation that can replace an active task.
Unsupported runtimes keep the button unavailable. Acceptance is not completion, and an
unknown result is never automatically retried. Drafts and original conversations are preserved.

<a id="schedules"></a>

## Session schedules

The clock icon in a session header opens **Current CLI schedules** and **Desktop saved definitions**. Enter the full prompt and a recurring interval or one-time local execution time, then choose **Save definition only** or **Save and register in CLI**. Definitions stay in the app's private database after the CLI exits or Desktop restarts. A session must have a confirmed conversation ID before a definition can be saved.

Execution schedules end when the owning CLI exits. Start the same conversation again and choose **Register in this CLI** to register a saved definition manually. Definitions cannot move to another conversation and are never registered automatically. No separate operating-system schedule or executor is created. An expired one-time definition requires a new future time before registration. Jobs created only in the CLI expose a preview, so their full prompts cannot be imported into Desktop definitions.

**Delete saved definition** removes the Desktop prompt and schedule while preserving existing CLI schedules. **Remove schedule** removes only the current CLI schedule and keeps the saved definition. An already registered definition cannot be registered again in the same CLI. Unknown registration results use refresh to reconcile the original request and are never retried automatically. If the original job ID cannot be confirmed, that definition remains blocked from re-registration, editing and deletion until the owning CLI exits.

Removing or pausing a schedule does not interrupt an accepted run. Cancelling an occurrence targets only the turn owned by that schedule and preserves recurring schedules. Unknown mutation results are never retried automatically and block further changes until reconciled. Runtimes without structured schedule control show an unsupported state and disable mutations.

<a id="mobile"></a>

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
failed start leaves saved sessions available for retry. Startup does not replace or
stop the shared daemon. Changing its version is a separate, confirmed action in
**Executable settings → Check server versions → Align server version…**.
OpenDIY startup uses R36's `--existing-installation` and guarded `--first-installation`
options. Missing protection options are reported without an individual-server fallback.

Official CLI uses an app-owned server. Mobile mutations require
`--remote-control-client-name` to avoid replacing other registrations. Actions stay disabled until a status response confirms that
mutations are allowed. The popup explains the connection scope and limitations.

Stopping a shared session pins its original turn ID before closing its terminal;
it never retargets a later mobile turn. Unconfirmed stops remain unknown and are
not automatically resent. The shared daemon and registration survive app exit.
If normal exit fails because a remote stop is unconfirmed, a separate **Close app
with unconfirmed remote stop** action becomes available only after all local resources have
been reaped. Remote work may continue. This action neither marks it stopped nor
resends the stop request.
Pairing codes are not saved. Physical phone pairing and control remain unvalidated.
Shared connections use the supported R36 CLI/server package. Check the release
notes for the executable and checksum.
A history-unavailable warning preserves live session input; it does not mean that
all previous messages have loaded.

<a id="usage"></a>

## Weekly usage

The lower-left indicator reads the selected CLI account's representative weekly
rate-limit window: an explicit 10,080-minute window, its used percentage and reset
time when provided. It is account usage, not a total calculated from this app's
sessions. Missing weekly data and read failures are shown separately and never
treated as 0%. Automatic reads run 60 seconds after the previous request settles and pause while
the window is hidden. Refresh reads immediately, with a five-second manual limit and one request
at a time. A failed refresh keeps the last confirmed value and its timestamp. Technical errors
are not shown in the usage panel. External session records are available in Settings.

<a id="storage"></a>

## Compatibility and attachment storage

Use **Settings → Executable settings → Check compatibility** to read only the selected executable version and help. This check opens no server connection and never calls `daemon version`. Server versions and feature declarations come only from existing sessions with the same executable and socket; they do not recheck current execution or connectivity. Unobserved versions and support, next-start selection that cannot be checked safely, and the actual server executable path remain unknown. Compaction also remains unknown in this check. Checking does not resume a session or install, start or replace a server. Each feature separately checks its connection, permissions and task state.

Use **Settings → Attachment storage** to inspect app-owned image usage and limits, distinguishing current-process unsent drafts, retained images and other files such as those from previous runs. Original local files are excluded. Remove draft attachments in their original session to free space. Submitted images, uncertain sends and files with unknown ownership are preserved.

<a id="data"></a>

## Codex and data

Install and sign in to OpenDIY Codex or a compatible official Codex CLI separately. OpenDIY Desktop uses
your existing login and honors `CODEX_HOME`. Initial CLI installation and sign-in remain separate. Desktop never changes global permission settings; a server-package transition requires the separate confirmation described above. Model selection stays
in Codex's own `/model` interface.

Managed sessions use a normal Codex terminal with an explicit conversation ID.
Shared lifecycle support is chosen by the required protection options, not merely a daemon command or CLI age. OpenDIY shared connections use their daemon; the official CLI uses an app-owned authenticated loopback server. External sessions are listed read-only through
the official daemon proxy. An unavailable shared server or unknown status is
reported explicitly, without starting another server.

Closing the window hides it to the tray. Complete exit terminates owned
processes after confirmation. Restoring after a complete exit starts new
processes against the saved conversation ID, rather than reviving an old PID.
Authentication tokens are not stored in the application database.
Layout, session metadata, imported projects, the executable choice and language
are stored in the app's own SQLite database. Browser previews use WebView local storage.
Terminal transcripts and Codex authentication files are not copied there.

<a id="memory"></a>

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
The selected CLI owns terminal history and model context. Desktop keeps its own
display and input buffers bounded; these limits do not bound the CLI process or
truncate durable history or model context.
These bounds and lifecycle tests are not a claim of a completed long-duration leak test.
Each session retains at most 1,024 answered or resolved server-request IDs. Exceeding this
limit blocks conversation observation and input handoff, rather than forgetting resolved requests
that could arrive again in a delayed replay. Original work and conversation data are preserved.

Existing saved settings and projects from Agent Grid are preserved. The longer-term
product direction is to learn from ChatGPT and Claude desktop workflows; the full
benchmark and broader feature migration are future work.

<a id="language"></a>

## Language

Open **⚙ Settings** in the upper-right corner and select **한국어** or **English**
under **Language**.
Changes apply immediately to the app interface and native tray/chooser labels,
and the desktop app saves the selection in its own SQLite settings for the next launch.
The default is Korean. Session titles, paths, conversations and terminal output
stay exactly as provided. CLI diagnostics and Windows system buttons can remain
in their original language; the app does not change the CLI or OS locale.
