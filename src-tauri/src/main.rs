#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut arguments = std::env::args().skip(1);
    let mode = arguments.next();
    if mode.as_deref() == Some("--agent-hook") {
        if let Some(db) = arguments.next() {
            athenas_agent_lib::notify::run_hook(std::path::Path::new(&db));
        }
        return;
    }
    if mode.as_deref() == Some("--mcp-stdio") {
        let Some(db) = arguments.next() else { return };
        let Some(project) = arguments.next() else {
            return;
        };
        if let Err(error) =
            athenas_agent_lib::orchestrator::run_mcp_stdio(std::path::Path::new(&db), &project)
        {
            eprintln!("Athenas MCP: {error}");
        }
        return;
    }
    athenas_agent_lib::run()
}
