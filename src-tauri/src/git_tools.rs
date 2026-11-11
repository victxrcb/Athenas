use serde::Serialize;
use std::{
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshot {
    branch: String,
    status: String,
    branches: Vec<String>,
    worktrees: String,
}

fn project_dir(folder: &str) -> Result<PathBuf, String> {
    let path =
        fs::canonicalize(folder).map_err(|_| "Pasta do projeto não encontrada.".to_string())?;
    if !path.is_dir() {
        return Err("Pasta do projeto inválida.".into());
    }
    Ok(path)
}

fn git(folder: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(folder)
        .args(args)
        .output()
        .map_err(|e| format!("Git não encontrado no PATH: {e}"))?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        return Err(error.trim().chars().take(1000).collect());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn file_pathspec(file: &str) -> Result<String, String> {
    let path = Path::new(file);
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Caminho de arquivo inválido.".into());
    }
    if file.contains('\0') {
        return Err("Caminho de arquivo inválido.".into());
    }
    Ok(format!(":(literal){}", file.replace('\\', "/")))
}

#[tauri::command]
pub fn git_snapshot(folder: String) -> Result<GitSnapshot, String> {
    let path = project_dir(&folder)?;
    git(&path, &["rev-parse", "--show-toplevel"])?;
    let branch = git(&path, &["branch", "--show-current"])?
        .trim()
        .to_string();
    let status = git(&path, &["status", "--short"])?;
    let branches = git(&path, &["branch", "--format=%(refname:short)"])?
        .lines()
        .map(str::to_string)
        .collect();
    let worktrees = git(&path, &["worktree", "list", "--porcelain"])?;
    Ok(GitSnapshot {
        branch,
        status,
        branches,
        worktrees,
    })
}

#[tauri::command]
pub fn git_file_diff(folder: String, file: String, staged: bool) -> Result<String, String> {
    let path = project_dir(&folder)?;
    let file = file_pathspec(&file)?;
    let args = if staged {
        vec!["diff", "--cached", "--", &file]
    } else {
        vec!["diff", "--", &file]
    };
    let diff = git(&path, &args)?;
    if diff.len() > 1024 * 1024 {
        return Err("Diff grande demais para abrir nesta visualização.".into());
    }
    Ok(diff)
}

#[tauri::command]
pub fn git_stage(folder: String, file: String, stage: bool) -> Result<(), String> {
    let path = project_dir(&folder)?;
    let file = file_pathspec(&file)?;
    if stage {
        git(&path, &["add", "--", &file])?;
    } else {
        git(&path, &["restore", "--staged", "--", &file])?;
    }
    Ok(())
}

#[tauri::command]
pub fn git_commit(folder: String, message: String) -> Result<String, String> {
    let path = project_dir(&folder)?;
    let message = message.trim();
    if message.is_empty() || message.chars().count() > 200 || message.chars().any(char::is_control)
    {
        return Err("Mensagem de commit inválida.".into());
    }
    git(&path, &["commit", "-m", message])
}

#[tauri::command]
pub fn git_create_worktree(folder: String, branch: String) -> Result<String, String> {
    let path = project_dir(&folder)?;
    let branch = branch.trim();
    if branch.is_empty()
        || branch.len() > 80
        || branch.contains("..")
        || branch.chars().any(char::is_control)
    {
        return Err("Nome de branch inválido.".into());
    }
    git(&path, &["check-ref-format", "--branch", branch])?;
    let parent = path.parent().ok_or("Pasta do projeto inválida.")?;
    let target = parent.join(format!(
        "{}-{}",
        path.file_name().unwrap().to_string_lossy(),
        branch.replace('/', "-")
    ));
    if target.exists() {
        return Err("A pasta do worktree já existe.".into());
    }
    git(
        &path,
        &[
            "worktree",
            "add",
            "-b",
            branch,
            target.to_str().ok_or("Caminho inválido.")?,
        ],
    )?;
    Ok(target.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_commands_stage_commit_and_show_diff_without_path_traversal() {
        assert!(file_pathspec("../outside.txt").is_err());
        assert!(file_pathspec("C:/outside.txt").is_err());
        let directory = std::env::temp_dir().join(format!("athenas-git-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        git(&directory, &["init", "-q"]).unwrap();
        git(&directory, &["config", "user.name", "Athenas Test"]).unwrap();
        git(&directory, &["config", "user.email", "test@localhost"]).unwrap();
        fs::write(directory.join("note.txt"), "first\n").unwrap();
        let folder = directory.to_string_lossy().into_owned();
        git_stage(folder.clone(), "note.txt".into(), true).unwrap();
        git_commit(folder.clone(), "test: first commit".into()).unwrap();
        fs::write(directory.join("note.txt"), "first\nsecond\n").unwrap();
        assert!(git_file_diff(folder.clone(), "note.txt".into(), false)
            .unwrap()
            .contains("+second"));
        assert!(git_snapshot(folder).unwrap().status.contains("note.txt"));
        fs::remove_dir_all(directory).unwrap();
    }
}
