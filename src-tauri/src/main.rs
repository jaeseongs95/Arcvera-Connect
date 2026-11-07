#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|arg| arg == "--self-test") {
        std::process::exit(agent_grid_lib::self_test::run());
    }
    if std::env::args().any(|arg| arg == "--codex-smoke") {
        std::process::exit(agent_grid_lib::self_test::run_codex_smoke());
    }
    if std::env::args().any(|arg| arg == "--remote") {
        std::process::exit(agent_grid_lib::remote_server::run_from_args());
    }
    agent_grid_lib::run();
}
