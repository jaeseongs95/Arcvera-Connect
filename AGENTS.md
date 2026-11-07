# OpenDIY Remote

Standalone browser-based remote control workspace for OpenDIY Codex (`https://github.com/jaeseongs95/opendiy-codex`), using the multi-session workspace UI architecture of OpenDIY Desktop (`https://github.com/jaeseongs95/opendiy-desktop`).

- Do NOT modify `opendiy-codex` or `opendiy-desktop` repositories.
- Keep `opendiy-remote` as a pure web remote-control server (`server/remote-server.mjs`) and browser frontend (`src/`, `index.html`) without Tauri desktop packaging (`src-tauri/`).
- Keep vendor protocols inside the server/bridge adapter and use runtime-reported models and capabilities; never hardcode model names.
- Preserve user authentication, config, and external sessions.
- New text: UTF-8 without BOM, LF.
- Verification commands: `npm ci`, `npm test`, `npm run build`, `npm run test:e2e`.
