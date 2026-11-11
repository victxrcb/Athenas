mod terminal;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
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
            terminal::terminal_save_image
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Hera Agent");
}
