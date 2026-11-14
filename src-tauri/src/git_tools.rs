use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::ErrorKind,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
};

/// Builds a non-interactive child process: no console window, no credential prompt on stdin.
fn command(program: &str) -> Command {
    let mut command = Command::new(program);
    command
        .stdin(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

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
    let output = command("git")
        .arg("-C")
        .arg(folder)
        .args(args)
        .output()
        .map_err(|e| format!("Git não encontrado no PATH: {e}"))?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        if error.contains("dubious ownership") {
            return Err(UNTRUSTED.into());
        }
        return Err(error.trim().chars().take(1000).collect());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Prefix the UI looks for to offer the "trust this folder" action.
pub const UNTRUSTED: &str = "PASTA_NAO_CONFIAVEL: o Git bloqueou esta pasta porque ela pertence a outro usuário do Windows (\"dubious ownership\").";

/// Adds the project folder to the user's `safe.directory` list (global git config), after an explicit click.
#[tauri::command]
pub fn git_trust_folder(folder: String) -> Result<(), String> {
    let path = project_dir(&folder)?;
    let text = path.to_string_lossy();
    let clean = text.strip_prefix(r"\\?\").unwrap_or(&text).replace('\\', "/");
    let output = command("git")
        .args(["config", "--global", "--add", "safe.directory", &clean])
        .output()
        .map_err(|e| format!("Git não encontrado no PATH: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().chars().take(500).collect());
    }
    Ok(())
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

// ---------------------------------------------------------------------------
// Remote repository: link parsing, remote branches and pull requests
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// github | azure | gitlab | bitbucket | other
    provider: String,
    host: String,
    /// `owner/repo` (GitHub), `org/project/repo` (Azure) or the full path elsewhere.
    slug: String,
    name: String,
    web_url: String,
    pulls_url: String,
    new_pull_url: String,
}

fn safe_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '%' | '~'))
}

/// Accepts `https://host/path`, `ssh://user@host/path` and `user@host:path`.
/// Links carrying a password or token are refused so secrets never get stored.
pub fn parse_repo(url: &str) -> Result<RepoInfo, String> {
    let url = url.trim();
    if url.is_empty() || url.len() > 300 || url.starts_with('-') || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("Link do repositório inválido.".into());
    }
    let (authority, path) = if let Some(rest) = ["https://", "http://", "ssh://"].iter().find_map(|scheme| url.strip_prefix(scheme)) {
        rest.split_once('/').ok_or("Link do repositório incompleto.")?
    } else if let Some((authority, path)) = url.split_once(':').filter(|(authority, _)| authority.contains('@') && !authority.contains('/')) {
        (authority, path)
    } else {
        return Err("Use um link https://… ou git@host:dono/repositorio.".into());
    };
    let (userinfo, host) = authority.rsplit_once('@').map_or((None, authority), |(user, host)| (Some(user), host));
    if userinfo.is_some_and(|user| user.contains(':')) {
        return Err("Não coloque usuário/senha ou token no link do repositório.".into());
    }
    let host = host.split(':').next().unwrap_or_default().to_ascii_lowercase();
    if host.is_empty() || !host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.')) {
        return Err("Servidor do repositório inválido.".into());
    }
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let segments: Vec<&str> = path.split('/').filter(|segment| !segment.is_empty()).collect();
    if segments.is_empty() || !segments.iter().all(|segment| safe_segment(segment)) {
        return Err("Caminho do repositório inválido.".into());
    }
    let incomplete = || "Link incompleto: informe dono e nome do repositório.".to_string();
    let info = |provider: &str, web_host: &str, slug: String, web_path: String, pulls: &str, new_pull: &str| {
        let web_url = format!("https://{web_host}/{web_path}");
        RepoInfo {
            provider: provider.into(),
            host: web_host.into(),
            name: slug.rsplit('/').next().unwrap_or_default().to_string(),
            slug,
            pulls_url: format!("{web_url}{pulls}"),
            new_pull_url: format!("{web_url}{new_pull}"),
            web_url,
        }
    };
    if host == "github.com" || host.contains("github") {
        let [owner, repo, ..] = segments[..] else { return Err(incomplete()) };
        let slug = format!("{owner}/{repo}");
        return Ok(info("github", &host, slug.clone(), slug, "/pulls", "/compare"));
    }
    let azure = |org: &str, project: &str, repo: &str, web_host: &str, web_path: String| {
        info("azure", web_host, format!("{org}/{project}/{repo}"), web_path, "/pullrequests?_a=active", "/pullrequestcreate")
    };
    if host == "dev.azure.com" {
        let [org, project, "_git", repo, ..] = segments[..] else { return Err(incomplete()) };
        return Ok(azure(org, project, repo, &host, format!("{org}/{project}/_git/{repo}")));
    }
    if host == "ssh.dev.azure.com" {
        let ["v3", org, project, repo, ..] = segments[..] else { return Err(incomplete()) };
        return Ok(azure(org, project, repo, "dev.azure.com", format!("{org}/{project}/_git/{repo}")));
    }
    if let Some(org) = host.strip_suffix(".visualstudio.com") {
        let [project, "_git", repo, ..] = segments[..] else { return Err(incomplete()) };
        return Ok(azure(org, project, repo, &host, format!("{project}/_git/{repo}")));
    }
    if segments.len() < 2 {
        return Err(incomplete());
    }
    let full = segments.join("/");
    Ok(if host.contains("gitlab") {
        info("gitlab", &host, full.clone(), full, "/-/merge_requests", "/-/merge_requests/new")
    } else if host == "bitbucket.org" {
        info("bitbucket", &host, full.clone(), full, "/pull-requests", "/pull-requests/new")
    } else {
        info("other", &host, full.clone(), full, "", "")
    })
}

/// Normalizes an optional link typed by the user before it is stored.
pub fn clean_repo_url(url: Option<String>) -> Result<Option<String>, String> {
    match url.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) {
        None => Ok(None),
        Some(value) => parse_repo(&value).map(|_| Some(value)),
    }
}

/// Name of the local remote that points to the same repository, if any.
fn matching_remote(folder: &Path, repo: &RepoInfo) -> Option<String> {
    let config = git(folder, &["config", "--get-regexp", r"^remote\..*\.url$"]).ok()?;
    config.lines().find_map(|line| {
        let (key, url) = line.split_once(' ')?;
        let name = key.strip_prefix("remote.")?.strip_suffix(".url")?;
        let other = parse_repo(url).ok()?;
        (other.web_url.eq_ignore_ascii_case(&repo.web_url)).then(|| name.to_string())
    })
}

fn git_folder(folder: Option<&str>) -> Option<PathBuf> {
    let path = project_dir(folder?).ok()?;
    git(&path, &["rev-parse", "--git-dir"]).ok()?;
    Some(path)
}

fn valid_branch(name: &str) -> Result<(), String> {
    let invalid = name.is_empty()
        || name.len() > 200
        || name.starts_with('-')
        || name.starts_with('/')
        || name.ends_with('/')
        || name.ends_with('.')
        || name.ends_with(".lock")
        || name.contains("..")
        || name.contains("@{")
        || name.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\'));
    if invalid { Err(format!("Nome de branch inválido: {name}")) } else { Ok(()) }
}

async fn blocking<T: Send + 'static>(task: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn git_repo_info(url: String) -> Result<RepoInfo, String> {
    parse_repo(&url)
}

/// `origin` of a folder, used to pre-fill the repository field. Links with credentials are skipped.
#[tauri::command]
pub fn git_origin_url(folder: String) -> Option<String> {
    let path = project_dir(&folder).ok()?;
    let url = git(&path, &["remote", "get-url", "origin"]).ok()?.trim().to_string();
    parse_repo(&url).ok().map(|_| url)
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranch {
    name: String,
    sha: String,
    date: Option<String>,
    author: Option<String>,
    subject: Option<String>,
    /// Local branch tracking this one.
    local: Option<String>,
    ahead: u32,
    behind: u32,
    current: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranches {
    /// Local remote matching the link; `None` means the list came straight from `git ls-remote`.
    remote: Option<String>,
    default_branch: Option<String>,
    branches: Vec<RemoteBranch>,
    fetch_error: Option<String>,
}

fn track_counts(track: &str) -> (u32, u32) {
    let count = |label: &str| {
        track.split(',').find_map(|part| part.trim().strip_prefix(label)?.trim().parse().ok()).unwrap_or(0)
    };
    (count("ahead"), count("behind"))
}

fn remote_branches(folder: Option<String>, url: String, fetch: bool) -> Result<RemoteBranches, String> {
    let repo = parse_repo(&url)?;
    let folder = git_folder(folder.as_deref());
    let matched = folder.as_ref().and_then(|path| matching_remote(path, &repo).map(|remote| (path, remote)));
    let Some((path, remote)) = matched else {
        // No local clone of this repository: list the heads directly from the server.
        let cwd = folder.unwrap_or_else(std::env::temp_dir);
        let output = git(&cwd, &["ls-remote", "--heads", &url])?;
        let branches = output
            .lines()
            .filter_map(|line| {
                let (sha, name) = line.split_once('\t')?;
                Some(RemoteBranch {
                    name: name.strip_prefix("refs/heads/")?.to_string(),
                    sha: sha.chars().take(7).collect(),
                    date: None, author: None, subject: None, local: None,
                    ahead: 0, behind: 0, current: false,
                })
            })
            .collect();
        return Ok(RemoteBranches { remote: None, default_branch: None, branches, fetch_error: None });
    };
    let fetch_error = if fetch { git(path, &["fetch", "--prune", &remote]).err() } else { None };
    let prefix = format!("{remote}/");
    let default_branch = git(path, &["symbolic-ref", "--short", &format!("refs/remotes/{remote}/HEAD")])
        .ok()
        .and_then(|value| value.trim().strip_prefix(&prefix).map(str::to_string));
    let current = git(path, &["branch", "--show-current"]).unwrap_or_default().trim().to_string();
    let mut tracking: HashMap<String, (String, u32, u32)> = HashMap::new();
    for line in git(path, &["for-each-ref", "--format=%(refname:short)%00%(upstream:short)%00%(upstream:track,nobracket)", "refs/heads"])?.lines() {
        let mut parts = line.split('\0');
        let (Some(local), Some(upstream), track) = (parts.next(), parts.next(), parts.next().unwrap_or_default()) else { continue };
        if let Some(name) = upstream.strip_prefix(&prefix) {
            let (ahead, behind) = track_counts(track);
            tracking.insert(name.to_string(), (local.to_string(), ahead, behind));
        }
    }
    let refs = git(path, &[
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short)%00%(objectname:short)%00%(committerdate:iso-strict)%00%(authorname)%00%(subject)",
        &format!("refs/remotes/{remote}"),
    ])?;
    let branches = refs
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\0').collect();
            let name = parts.first()?.strip_prefix(&prefix)?;
            if name == "HEAD" { return None; }
            let field = |index: usize| parts.get(index).map(|value| value.to_string()).filter(|value| !value.is_empty());
            let (local, ahead, behind) = tracking.get(name).cloned().map_or((None, 0, 0), |(local, a, b)| (Some(local), a, b));
            Some(RemoteBranch {
                current: local.as_deref() == Some(current.as_str()) && !current.is_empty(),
                name: name.to_string(),
                sha: field(1).unwrap_or_default(),
                date: field(2), author: field(3), subject: field(4),
                local, ahead, behind,
            })
        })
        .collect();
    Ok(RemoteBranches { remote: Some(remote), default_branch, branches, fetch_error })
}

#[tauri::command]
pub async fn git_remote_branches(folder: Option<String>, url: String, fetch: bool) -> Result<RemoteBranches, String> {
    blocking(move || remote_branches(folder, url, fetch)).await
}

/// `git push -u <remote> <branch>` to the remote that matches the repository link.
#[tauri::command]
pub async fn git_push_branch(folder: String, url: String, branch: String) -> Result<String, String> {
    blocking(move || {
        valid_branch(&branch)?;
        let repo = parse_repo(&url)?;
        let path = git_folder(Some(&folder)).ok_or("A pasta do projeto não é um repositório Git.")?;
        let remote = matching_remote(&path, &repo).ok_or("Nenhum remoto desta pasta aponta para o repositório do projeto.")?;
        git(&path, &["push", "-u", &remote, &format!("refs/heads/{branch}:refs/heads/{branch}")])?;
        Ok(format!("{branch} enviada para {remote}."))
    })
    .await
}

fn gh(args: &[&str]) -> Result<String, String> {
    let output = command("gh").args(args).output().map_err(|e| {
        if e.kind() == ErrorKind::NotFound {
            "GitHub CLI (gh) não encontrado. Instale em https://cli.github.com e rode `gh auth login`.".to_string()
        } else {
            format!("Falha ao executar o GitHub CLI: {e}")
        }
    })?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        let error = error.trim();
        if error.contains("gh auth login") {
            return Err("GitHub CLI sem login. Rode `gh auth login` no terminal.".into());
        }
        return Err(error.chars().take(1000).collect());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn github_repo(url: &str) -> Result<String, String> {
    let repo = parse_repo(url)?;
    if repo.provider != "github" {
        return Err("Pull requests pelo app funcionam com repositórios do GitHub.".into());
    }
    Ok(if repo.host == "github.com" { repo.slug } else { format!("{}/{}", repo.host, repo.slug) })
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct GhAuthor {
    login: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPullRequest {
    number: u64,
    title: String,
    url: String,
    head_ref_name: String,
    base_ref_name: String,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    author: Option<GhAuthor>,
    #[serde(default)]
    review_decision: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    number: u64,
    title: String,
    url: String,
    head_ref_name: String,
    base_ref_name: String,
    is_draft: bool,
    created_at: String,
    author: Option<String>,
    review_decision: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequests {
    default_branch: Option<String>,
    items: Vec<PullRequest>,
}

#[tauri::command]
pub async fn git_pull_requests(url: String) -> Result<PullRequests, String> {
    blocking(move || {
        let repo = github_repo(&url)?;
        let output = gh(&["pr", "list", "-R", &repo, "--state", "open", "--limit", "100", "--json",
            "number,title,url,headRefName,baseRefName,isDraft,createdAt,author,reviewDecision"])?;
        let items: Vec<GhPullRequest> = serde_json::from_str(&output).map_err(|e| format!("Resposta inesperada do GitHub CLI: {e}"))?;
        let default_branch = gh(&["repo", "view", &repo, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"])
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        Ok(PullRequests {
            default_branch,
            items: items
                .into_iter()
                .map(|item| PullRequest {
                    number: item.number,
                    title: item.title,
                    url: item.url,
                    head_ref_name: item.head_ref_name,
                    base_ref_name: item.base_ref_name,
                    is_draft: item.is_draft,
                    created_at: item.created_at,
                    author: item.author.map(|author| author.login).filter(|login| !login.is_empty()),
                    review_decision: item.review_decision.filter(|value| !value.is_empty()),
                })
                .collect(),
        })
    })
    .await
}

#[tauri::command]
pub async fn git_create_pull_request(url: String, base: String, head: String, title: String, body: String, draft: bool) -> Result<String, String> {
    blocking(move || {
        let repo = github_repo(&url)?;
        let (base, head, title) = (base.trim(), head.trim(), title.trim());
        valid_branch(base)?;
        valid_branch(head)?;
        if base == head {
            return Err("A branch de origem e a de destino precisam ser diferentes.".into());
        }
        if title.is_empty() || title.chars().count() > 256 || title.chars().any(char::is_control) {
            return Err("Título do PR inválido (até 256 caracteres, sem quebras de linha).".into());
        }
        if body.chars().count() > 20_000 || body.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')) {
            return Err("Descrição do PR inválida ou longa demais.".into());
        }
        let (base, head, title, body) = (format!("--base={base}"), format!("--head={head}"), format!("--title={title}"), format!("--body={body}"));
        let mut args = vec!["pr", "create", "-R", &repo, &base, &head, &title, &body];
        if draft {
            args.push("--draft");
        }
        let output = gh(&args)?;
        Ok(output.lines().rev().find(|line| line.trim().starts_with("https://")).unwrap_or(output.trim()).trim().to_string())
    })
    .await
}

/// Opens an https link (repository, PR) in the default browser.
#[tauri::command]
pub fn git_open_url(url: String) -> Result<(), String> {
    let url = url.trim();
    if !url.starts_with("https://") || url.len() > 2000 || url.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '"' | '\'' | '`' | '<' | '>')) {
        return Err("Link inválido.".into());
    }
    let program = if cfg!(windows) { "explorer.exe" } else if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    Command::new(program).arg(url).spawn().map_err(|e| format!("Falha ao abrir o navegador: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_links_are_parsed_per_provider_and_reject_credentials() {
        let github = parse_repo("https://github.com/victxrcb/Athenas.git").unwrap();
        assert_eq!((github.provider.as_str(), github.slug.as_str()), ("github", "victxrcb/Athenas"));
        assert_eq!(github.pulls_url, "https://github.com/victxrcb/Athenas/pulls");
        assert_eq!(parse_repo("git@github.com:victxrcb/Athenas.git").unwrap(), github);
        assert_eq!(parse_repo("https://github.com/victxrcb/Athenas/tree/main").unwrap().slug, "victxrcb/Athenas");
        let azure = parse_repo("https://org@dev.azure.com/org/Proj/_git/api").unwrap();
        assert_eq!((azure.provider.as_str(), azure.web_url.as_str()), ("azure", "https://dev.azure.com/org/Proj/_git/api"));
        assert_eq!(parse_repo("git@ssh.dev.azure.com:v3/org/Proj/api").unwrap().web_url, azure.web_url);
        assert_eq!(parse_repo("https://gitlab.com/group/sub/app").unwrap().new_pull_url, "https://gitlab.com/group/sub/app/-/merge_requests/new");
        assert!(parse_repo("https://user:token@github.com/a/b").is_err());
        assert!(parse_repo("--upload-pack=evil").is_err());
        assert!(parse_repo("https://github.com/only-owner").is_err());
        assert!(parse_repo("https://github.com/a/../b").is_err());
        assert!(parse_repo("C:\\repo").is_err());
        assert_eq!(clean_repo_url(Some("  ".into())).unwrap(), None);
    }

    #[test]
    fn branch_names_and_tracking_counts() {
        assert!(valid_branch("feature/mascote").is_ok());
        assert!(valid_branch("-x").is_err());
        assert!(valid_branch("a..b").is_err());
        assert!(valid_branch("tem espaço").is_err());
        assert_eq!(track_counts("ahead 2, behind 3"), (2, 3));
        assert_eq!(track_counts("behind 1"), (0, 1));
        assert_eq!(track_counts("gone"), (0, 0));
    }

    #[test]
    fn remote_branches_follow_the_matching_remote_with_tracking() {
        let root = std::env::temp_dir().join(format!("athenas-remote-{}", uuid::Uuid::new_v4()));
        let (origin, clone) = (root.join("origin"), root.join("clone"));
        fs::create_dir_all(&origin).unwrap();
        fs::create_dir_all(&clone).unwrap();
        git(&origin, &["init", "-q", "-b", "main"]).unwrap();
        git(&origin, &["config", "user.name", "Athenas Test"]).unwrap();
        git(&origin, &["config", "user.email", "test@localhost"]).unwrap();
        fs::write(origin.join("a.txt"), "a\n").unwrap();
        git(&origin, &["add", "."]).unwrap();
        git(&origin, &["commit", "-q", "-m", "first"]).unwrap();
        git(&origin, &["branch", "feature/x"]).unwrap();
        git(&clone, &["init", "-q", "-b", "main"]).unwrap();
        let url = "https://github.com/acme/demo.git";
        git(&clone, &["remote", "add", "origin", url]).unwrap();
        // Point fetches at the local origin while the configured URL still matches the project link.
        let origin_url = origin.to_string_lossy().replace('\\', "/");
        git(&clone, &["config", &format!("url.{origin_url}.insteadOf"), url]).unwrap();
        let folder = Some(clone.to_string_lossy().into_owned());
        let listed = remote_branches(folder.clone(), url.into(), true).unwrap();
        assert_eq!(listed.remote.as_deref(), Some("origin"));
        assert_eq!(listed.fetch_error, None);
        let mut names: Vec<_> = listed.branches.iter().map(|branch| branch.name.as_str()).collect();
        names.sort();
        assert_eq!(names, ["feature/x", "main"]);
        git(&clone, &["checkout", "-q", "-B", "main", "--track", "origin/main"]).unwrap();
        git(&clone, &["config", "user.name", "Athenas Test"]).unwrap();
        git(&clone, &["config", "user.email", "test@localhost"]).unwrap();
        fs::write(clone.join("b.txt"), "b\n").unwrap();
        git(&clone, &["add", "."]).unwrap();
        git(&clone, &["commit", "-q", "-m", "local"]).unwrap();
        let listed = remote_branches(folder, url.into(), false).unwrap();
        let main = listed.branches.iter().find(|branch| branch.name == "main").unwrap();
        assert_eq!((main.local.as_deref(), main.ahead, main.behind, main.current), (Some("main"), 1, 0, true));
        assert_eq!(main.subject.as_deref(), Some("first"));
        fs::remove_dir_all(root).ok();
    }

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
