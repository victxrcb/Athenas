mod git_tools;
mod history;
pub mod links;
mod mcp_config;
pub mod notify;
pub mod orchestrator;
mod schedule;
mod settings;
mod skills;
mod spotify;
mod terminal;
mod usage;
mod workspace;

use tauri::Manager;

/// Apps opened from Finder or a desktop launcher get a minimal PATH, so `claude` and `codex` would not be
/// found. Adopt the PATH of the user's login shell, plus the usual install folders as a fallback.
#[cfg(not(windows))]
fn inherit_login_path() {
    use std::{process::{Command, Stdio}, time::{Duration, Instant}};
    const MARK: &str = "__ATHENAS_PATH__";
    let shell = std::env::var("SHELL").ok().filter(|value| !value.is_empty()).unwrap_or_else(|| "/bin/sh".into());
    let login_path = Command::new(&shell)
        .args(["-ilc", &format!("printf '{MARK}%s' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()
        .and_then(|mut child| {
            // A slow or interactive shell profile must not block startup.
            let started = Instant::now();
            while matches!(child.try_wait(), Ok(None)) {
                if started.elapsed() > Duration::from_secs(4) {
                    let _ = child.kill();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            let output = child.wait_with_output().ok()?;
            let text = String::from_utf8_lossy(&output.stdout).into_owned();
            text.rsplit_once(MARK).map(|(_, path)| path.trim().to_string())
        })
        .filter(|path| !path.is_empty());
    let mut entries: Vec<String> = login_path
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default()
        .split(':')
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect();
    let home = std::env::var("HOME").unwrap_or_default();
    for extra in [format!("{home}/.local/bin"), format!("{home}/.npm-global/bin"), "/opt/homebrew/bin".into(), "/usr/local/bin".into(), "/usr/bin".into(), "/bin".into()] {
        if !entries.contains(&extra) {
            entries.push(extra);
        }
    }
    std::env::set_var("PATH", entries.join(":"));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(not(windows))]
    inherit_login_path();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let preferences =
                settings::PreferencesStore::new(&app.handle()).map_err(std::io::Error::other)?;
            app.manage(preferences.clone());
            app.manage(workspace::WorkspaceDb::new(&app.handle()).map_err(std::io::Error::other)?);
            app.manage(terminal::TerminalState::new(&app.handle()));
            notify::start(app.handle().clone(), app.path().app_data_dir()?);
            let links = links::LinksDb::new(&app.handle()).map_err(std::io::Error::other)?;
            links.start(app.handle().clone());
            app.manage(links);
            let orchestrator = orchestrator::Orchestrator::new(&app.handle(), preferences)
                .map_err(std::io::Error::other)?;
            orchestrator.start();
            app.manage(orchestrator);
            let scheduler = schedule::Scheduler::new(&app.handle()).map_err(std::io::Error::other)?;
            scheduler.start(app.handle().clone());
            app.manage(scheduler);
            app.manage(history::HistoryIndex::new(&app.handle()).map_err(std::io::Error::other)?);
            // Build the conversation index early so the first search is fast.
            let warm = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(4));
                let _ = warm.state::<history::HistoryIndex>().refresh();
            });
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
            terminal::terminal_rename,
            terminal::terminal_auto_title,
            notify::open_local_url,
            terminal::group_metrics,
            usage::agent_quotas,
            spotify::spotify_status,
            spotify::spotify_control,
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
            workspace::project_update,
            workspace::project_delete,
            workspace::project_set_icon,
            workspace::project_reveal,
            workspace::project_open_vscode,
            workspace::mapping_layout_get,
            workspace::mapping_layout_save,
            links::agent_links_list,
            links::agent_link_create,
            links::agent_link_delete,
            links::agent_link_introduce,
            git_tools::git_snapshot,
            git_tools::git_file_diff,
            git_tools::git_stage,
            git_tools::git_commit,
            git_tools::git_create_worktree,
            git_tools::git_repo_info,
            git_tools::git_origin_url,
            git_tools::git_remote_branches,
            git_tools::git_push_branch,
            git_tools::git_pull_requests,
            git_tools::git_create_pull_request,
            git_tools::git_open_url,
            git_tools::git_trust_folder,
            skills::skills_list,
            skills::skill_open_folder,
            mcp_config::mcp_config_list,
            mcp_config::mcp_config_write,
            mcp_config::mcp_register_orchestrator,
            orchestrator::orchestration_list,
            orchestrator::orchestration_delegate,
            orchestrator::orchestration_result,
            orchestrator::orchestration_transcript,
            orchestrator::orchestration_resume,
            orchestrator::orchestration_land,
            orchestrator::orchestration_permission,
            orchestrator::orchestration_abort,
            notify::notify_show,
            history::history_search,
            history::history_messages,
            history::history_usage,
            schedule::schedule_list,
            schedule::schedule_create,
            schedule::schedule_cancel,
            schedule::schedule_delete,
            schedule::schedule_run_now,
            settings::settings_get,
            settings::settings_save
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Athenas Agent");
}
