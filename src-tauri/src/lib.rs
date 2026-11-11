mod git_tools;
mod mcp_config;
mod skills;
mod terminal;
mod workspace;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(workspace::WorkspaceDb::new(&app.handle()).map_err(std::io::Error::other)?);
            app.manage(terminal::TerminalState::new(&app.handle()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            terminal::terminal_list,
            terminal::terminal_start,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_scrollback,
            terminal::terminal_stop,
            terminal::terminal_set_pane,
            terminal::group_metrics,
            terminal::group_suspend,
            terminal::terminal_save_image,
            workspace::workspace_list,
            workspace::group_create,
            workspace::project_create,
            workspace::project_set_layout,
            workspace::project_set_split,
            workspace::pane_create,
            git_tools::git_snapshot,
            git_tools::git_file_diff,
            git_tools::git_stage,
            git_tools::git_commit,
            git_tools::git_create_worktree,
            skills::skills_list,
            skills::skill_open_folder,
            mcp_config::mcp_config_list,
            mcp_config::mcp_config_write
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Athenas Agent");
}
