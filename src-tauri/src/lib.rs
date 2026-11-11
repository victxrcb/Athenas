mod git_tools;
mod mcp_config;
pub mod orchestrator;
mod settings;
mod skills;
mod terminal;
mod workspace;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let preferences =
                settings::PreferencesStore::new(&app.handle()).map_err(std::io::Error::other)?;
            app.manage(preferences.clone());
            app.manage(workspace::WorkspaceDb::new(&app.handle()).map_err(std::io::Error::other)?);
            app.manage(terminal::TerminalState::new(&app.handle()));
            let orchestrator = orchestrator::Orchestrator::new(&app.handle(), preferences)
                .map_err(std::io::Error::other)?;
            orchestrator.start();
            app.manage(orchestrator);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            terminal::terminal_list,
            terminal::terminal_start,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_scrollback,
            terminal::terminal_stop,
            terminal::terminal_delete,
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
            workspace::pane_set_pinned,
            workspace::pane_delete,
            workspace::project_open_vscode,
            git_tools::git_snapshot,
            git_tools::git_file_diff,
            git_tools::git_stage,
            git_tools::git_commit,
            git_tools::git_create_worktree,
            skills::skills_list,
            skills::skill_open_folder,
            mcp_config::mcp_config_list,
            mcp_config::mcp_config_write,
            mcp_config::mcp_register_orchestrator,
            orchestrator::orchestration_list,
            orchestrator::orchestration_delegate,
            orchestrator::orchestration_result,
            orchestrator::orchestration_resume,
            orchestrator::orchestration_land,
            orchestrator::orchestration_permission,
            orchestrator::orchestration_abort,
            settings::settings_get,
            settings::settings_save
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Athenas Agent");
}
