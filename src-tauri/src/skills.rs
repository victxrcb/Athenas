use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    name: String,
    description: String,
    path: String,
    agent: String,
}

fn frontmatter(path: &Path) -> (String, String) {
    let default = path
        .parent()
        .and_then(Path::file_name)
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let source = fs::read_to_string(path).unwrap_or_default();
    if !source.starts_with("---") {
        return (default, String::new());
    }
    let mut name = None;
    let mut description = None;
    for line in source.lines().skip(1).take(80) {
        if line.trim() == "---" {
            break;
        }
        if let Some(value) = line.strip_prefix("name:") {
            name = Some(
                value
                    .trim()
                    .trim_matches(|c| c == '\'' || c == '"')
                    .to_string(),
            );
        }
        if let Some(value) = line.strip_prefix("description:") {
            description = Some(
                value
                    .trim()
                    .trim_matches(|c| c == '\'' || c == '"')
                    .to_string(),
            );
        }
    }
    (
        name.filter(|value| !value.is_empty()).unwrap_or(default),
        description.unwrap_or_default(),
    )
}

fn scan_root(root: &Path, agent: &str, depth: usize, result: &mut Vec<SkillInfo>) {
    if depth > 2 {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if !kind.is_dir() || kind.is_symlink() {
            continue;
        }
        let directory = entry.path();
        let file = directory.join("SKILL.md");
        if file.is_file() {
            let (name, description) = frontmatter(&file);
            result.push(SkillInfo {
                name,
                description,
                path: directory.to_string_lossy().into_owned(),
                agent: agent.into(),
            });
        } else {
            scan_root(&directory, agent, depth + 1, result);
        }
    }
}

fn scan(app: &AppHandle, project_folder: Option<&str>) -> Result<Vec<SkillInfo>, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let mut roots: Vec<(PathBuf, &str)> = vec![
        (home.join(".claude/skills"), "Claude Code"),
        (home.join(".codex/skills"), "Codex"),
    ];
    if let Some(folder) = project_folder {
        let project =
            fs::canonicalize(folder).map_err(|_| "Pasta do projeto não encontrada.".to_string())?;
        if !project.is_dir() {
            return Err("Pasta do projeto inválida.".into());
        }
        roots.push((project.join(".claude/skills"), "Claude Code"));
        roots.push((project.join(".codex/skills"), "Codex"));
    }
    let mut result = Vec::new();
    for (root, agent) in roots {
        scan_root(&root, agent, 0, &mut result);
    }
    result.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(result)
}

#[tauri::command]
pub fn skills_list(
    app: AppHandle,
    project_folder: Option<String>,
) -> Result<Vec<SkillInfo>, String> {
    scan(&app, project_folder.as_deref())
}

#[tauri::command]
pub fn skill_open_folder(
    app: AppHandle,
    project_folder: Option<String>,
    path: String,
) -> Result<(), String> {
    let allowed = scan(&app, project_folder.as_deref())?
        .into_iter()
        .any(|skill| skill.path == path);
    if !allowed {
        return Err("Skill não encontrada.".into());
    }
    let program = if cfg!(windows) {
        "explorer.exe"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    Command::new(program)
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
