use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub claude_command: String,
    pub codex_command: String,
    pub shell_command: String,
    pub worker_limit: usize,
    pub scrollback_mb: usize,
    pub font_size: usize,
    pub reduced_effects: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            claude_command: "claude".into(),
            codex_command: "codex".into(),
            shell_command: if cfg!(windows) {
                "powershell.exe"
            } else {
                "sh"
            }
            .into(),
            worker_limit: 3,
            scrollback_mb: 5,
            font_size: 13,
            reduced_effects: false,
        }
    }
}

#[derive(Clone)]
pub struct PreferencesStore {
    path: PathBuf,
    value: Arc<Mutex<Preferences>>,
}

fn valid_command(command: &str) -> bool {
    !command.trim().is_empty()
        && command.len() <= 500
        && !command
            .chars()
            .any(|ch| ch == '\0' || ch == '\r' || ch == '\n')
}

impl PreferencesStore {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let path = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("preferences.json");
        let value = match fs::read_to_string(&path) {
            Ok(text) => {
                serde_json::from_str(&text).map_err(|e| format!("Preferências inválidas: {e}"))?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Preferences::default(),
            Err(error) => return Err(error.to_string()),
        };
        Ok(Self {
            path,
            value: Arc::new(Mutex::new(value)),
        })
    }

    pub fn snapshot(&self) -> Result<Preferences, String> {
        self.value
            .lock()
            .map(|value| value.clone())
            .map_err(|e| e.to_string())
    }

    fn save(&self, next: Preferences) -> Result<Preferences, String> {
        if !valid_command(&next.claude_command)
            || !valid_command(&next.codex_command)
            || !valid_command(&next.shell_command)
            || !(1..=8).contains(&next.worker_limit)
            || !(1..=50).contains(&next.scrollback_mb)
            || !(11..=24).contains(&next.font_size)
        {
            return Err("Preferências inválidas. Confira comandos e limites.".into());
        }
        fs::create_dir_all(
            self.path
                .parent()
                .ok_or("Pasta de preferências inválida.")?,
        )
        .map_err(|e| e.to_string())?;
        let temp = self
            .path
            .with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        if let Err(error) = crate::mcp_config::atomic_replace(&temp, &self.path) {
            let _ = fs::remove_file(temp);
            return Err(error);
        }
        *self.value.lock().map_err(|e| e.to_string())? = next.clone();
        Ok(next)
    }
}

#[tauri::command]
pub fn settings_get(state: tauri::State<'_, PreferencesStore>) -> Result<Preferences, String> {
    state.snapshot()
}

#[tauri::command]
pub fn settings_save(
    state: tauri::State<'_, PreferencesStore>,
    settings: Preferences,
) -> Result<Preferences, String> {
    state.save(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferences_validate_bounds_and_persist() {
        let path =
            std::env::temp_dir().join(format!("athenas-settings-{}.json", uuid::Uuid::new_v4()));
        let store = PreferencesStore {
            path: path.clone(),
            value: Arc::new(Mutex::new(Preferences::default())),
        };
        let mut settings = store.snapshot().unwrap();
        settings.worker_limit = 0;
        assert!(store.save(settings).is_err());
        let mut settings = store.snapshot().unwrap();
        settings.worker_limit = 4;
        store.save(settings).unwrap();
        let saved: Preferences = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved.worker_limit, 4);
        fs::remove_file(path).unwrap();
    }
}
