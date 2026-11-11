use serde::Serialize;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigFile {
    id: String,
    agent: String,
    path: String,
    text: String,
    servers: Vec<String>,
}

fn config_path(
    app: &AppHandle,
    id: &str,
    project_folder: Option<&str>,
) -> Result<(PathBuf, &'static str), String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    match id {
        "claude_user" => Ok((home.join(".claude.json"), "Claude Code")),
        "codex_user" => Ok((home.join(".codex/config.toml"), "Codex")),
        "claude_project" => {
            let folder = project_folder.ok_or("Escolha um projeto.")?;
            let root = fs::canonicalize(folder)
                .map_err(|_| "Pasta do projeto não encontrada.".to_string())?;
            if !root.is_dir() {
                return Err("Pasta do projeto inválida.".into());
            }
            Ok((root.join(".mcp.json"), "Claude Code"))
        }
        _ => Err("Configuração MCP desconhecida.".into()),
    }
}

fn parse_servers(id: &str, text: &str) -> Result<Vec<String>, String> {
    if text.len() > 1024 * 1024 {
        return Err("Configuração MCP acima de 1 MB.".into());
    }
    if id == "codex_user" {
        let value: toml::Value = text.parse().map_err(|e| format!("TOML inválido: {e}"))?;
        let Some(table) = value.as_table() else {
            return Err("A configuração Codex precisa ser uma tabela TOML.".into());
        };
        let servers = table
            .get("mcp_servers")
            .map(|value| {
                value
                    .as_table()
                    .ok_or("mcp_servers precisa ser uma tabela.".to_string())
            })
            .transpose()?;
        Ok(servers
            .map(|map| map.keys().cloned().collect())
            .unwrap_or_default())
    } else {
        let value: serde_json::Value =
            serde_json::from_str(text).map_err(|e| format!("JSON inválido: {e}"))?;
        let Some(object) = value.as_object() else {
            return Err("A configuração Claude precisa ser um objeto JSON.".into());
        };
        let servers = object
            .get("mcpServers")
            .map(|value| {
                value
                    .as_object()
                    .ok_or("mcpServers precisa ser um objeto.".to_string())
            })
            .transpose()?;
        Ok(servers
            .map(|map| map.keys().cloned().collect())
            .unwrap_or_default())
    }
}

fn empty_text(id: &str) -> &'static str {
    if id == "codex_user" {
        "[mcp_servers]\n"
    } else {
        "{\n  \"mcpServers\": {}\n}\n"
    }
}

fn read_config(
    app: &AppHandle,
    id: &str,
    project_folder: Option<&str>,
) -> Result<McpConfigFile, String> {
    let (path, agent) = config_path(app, id, project_folder)?;
    let text = match fs::read_to_string(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => empty_text(id).into(),
        Err(error) => return Err(error.to_string()),
    };
    let servers = parse_servers(id, &text)?;
    Ok(McpConfigFile {
        id: id.into(),
        agent: agent.into(),
        path: path.to_string_lossy().into_owned(),
        text,
        servers,
    })
}

#[tauri::command]
pub fn mcp_config_list(
    app: AppHandle,
    project_folder: Option<String>,
) -> Result<Vec<McpConfigFile>, String> {
    let mut configs = Vec::new();
    for id in ["claude_user", "codex_user"] {
        configs.push(read_config(&app, id, project_folder.as_deref())?);
    }
    if project_folder.is_some() {
        configs.push(read_config(
            &app,
            "claude_project",
            project_folder.as_deref(),
        )?);
    }
    Ok(configs)
}

#[cfg(windows)]
fn atomic_replace(temp: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace(temp: &Path, target: &Path) -> Result<(), String> {
    fs::rename(temp, target).map_err(|e| e.to_string())
}

fn write_config(path: &Path, text: &str) -> Result<(), String> {
    if path
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err("Não é permitido editar um link simbólico de configuração.".into());
    }
    let parent = path.parent().ok_or("Caminho de configuração inválido.")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    if path.exists() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();
        let backup = path.with_extension(format!("bak.{stamp}"));
        fs::copy(path, backup).map_err(|e| e.to_string())?;
    }
    let temp = parent.join(format!(".athenas-mcp-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| e.to_string())?;
    file.write_all(text.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    if let Err(error) = atomic_replace(&temp, path) {
        let _ = fs::remove_file(temp);
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub fn mcp_config_write(
    app: AppHandle,
    id: String,
    project_folder: Option<String>,
    text: String,
) -> Result<McpConfigFile, String> {
    parse_servers(&id, &text)?;
    let (path, _) = config_path(&app, &id, project_folder.as_deref())?;
    write_config(&path, &text)?;
    read_config(&app, &id, project_folder.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_valid_config_with_backup_and_rejects_invalid_content() {
        let directory = std::env::temp_dir().join(format!("athenas-mcp-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("config.json");
        write_config(&path, "{\"mcpServers\":{}}").unwrap();
        assert!(parse_servers("claude_user", "{\"mcpServers\":{\"local\":{}}}").is_ok());
        assert!(parse_servers("claude_user", "{bad}").is_err());
        write_config(&path, "{\"mcpServers\":{\"local\":{}}}").unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\"mcpServers\":{\"local\":{}}}"
        );
        assert!(fs::read_dir(&directory)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".bak.")));
        fs::remove_dir_all(directory).unwrap();
    }
}
