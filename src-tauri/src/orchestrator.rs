use crate::settings::Preferences;
use crate::settings::PreferencesStore;
use portable_pty::{ChildKiller, CommandBuilder};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

struct ProcessKiller(u32);

impl std::fmt::Debug for ProcessKiller {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ProcessKiller({})", self.0)
    }
}

impl ChildKiller for ProcessKiller {
    fn kill(&mut self) -> std::io::Result<()> {
        let pid = self.0.to_string();
        let mut command = if cfg!(windows) {
            let mut c = Command::new("taskkill");
            c.args(["/PID", &pid, "/T", "/F"]);
            c
        } else {
            let mut c = Command::new("kill");
            c.args(["-9", &pid]);
            c
        };
        command.stdout(Stdio::null()).stderr(Stdio::null()).status().map(|_| ())
    }
    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(ProcessKiller(self.0))
    }
}

#[derive(Clone)]
pub struct Orchestrator {
    db_path: PathBuf,
    active: Arc<Mutex<Vec<String>>>,
    killers: Arc<Mutex<HashMap<String, Box<dyn ChildKiller + Send + Sync>>>>,
    preferences: PreferencesStore,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worker {
    pub id: String,
    pub run_id: String,
    pub project: String,
    pub agent: String,
    pub brief: String,
    pub branch: String,
    pub worktree: String,
    pub status: String,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub files_changed: Option<i64>,
    pub lines_changed: Option<i64>,
    pub error: Option<String>,
    pub permission_request: Option<String>,
}

fn db(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let connection = Connection::open(path).map_err(|e| e.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, base_branch TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()));
        CREATE TABLE IF NOT EXISTS workers (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), project TEXT NOT NULL,
        agent TEXT NOT NULL, brief TEXT NOT NULL, branch TEXT NOT NULL, worktree TEXT NOT NULL,
        status TEXT NOT NULL, started_at INTEGER, finished_at INTEGER, tokens INTEGER,
        cost_usd REAL, files_changed INTEGER, lines_changed INTEGER, error TEXT,
        session_id TEXT, permission_request TEXT, allowed_tools TEXT NOT NULL DEFAULT '[]',
        once_tools TEXT NOT NULL DEFAULT '[]',
        retry_count INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS workers_run ON workers(run_id);
        CREATE INDEX IF NOT EXISTS workers_status ON workers(status);",
        )
        .map_err(|e| e.to_string())?;
    let columns = connection
        .prepare("PRAGMA table_info(workers)")
        .map_err(|e| e.to_string())?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for (name, definition) in [
        ("session_id", "TEXT"),
        ("permission_request", "TEXT"),
        ("allowed_tools", "TEXT NOT NULL DEFAULT '[]'"),
        ("once_tools", "TEXT NOT NULL DEFAULT '[]'"),
        ("retry_count", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !columns.iter().any(|column| column == name) {
            connection
                .execute_batch(&format!(
                    "ALTER TABLE workers ADD COLUMN {name} {definition}"
                ))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(connection)
}

fn worker_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Worker> {
    Ok(Worker {
        id: row.get(0)?,
        run_id: row.get(1)?,
        project: row.get(2)?,
        agent: row.get(3)?,
        brief: row.get(4)?,
        branch: row.get(5)?,
        worktree: row.get(6)?,
        status: row.get(7)?,
        started_at: row.get(8)?,
        finished_at: row.get(9)?,
        tokens: row.get(10)?,
        cost_usd: row.get(11)?,
        files_changed: row.get(12)?,
        lines_changed: row.get(13)?,
        error: row.get(14)?,
        permission_request: row.get(15)?,
    })
}

fn list(path: &Path, project: Option<&str>, run_id: Option<&str>) -> Result<Vec<Worker>, String> {
    let normalized = project.map(|value| {
        fs::canonicalize(value)
            .map(|path| native_path(&path).to_string_lossy().into_owned())
            .unwrap_or_else(|_| value.to_string())
    });
    let connection = db(path)?;
    let mut statement = connection.prepare("SELECT id,run_id,project,agent,brief,branch,worktree,status,
        started_at,finished_at,tokens,cost_usd,files_changed,lines_changed,error,permission_request FROM workers
        WHERE (?1 IS NULL OR project=?1) AND (?2 IS NULL OR run_id=?2)
        ORDER BY rowid DESC").map_err(|e| e.to_string())?;
    let result = statement
        .query_map(params![normalized, run_id], worker_from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    result
}

fn git(folder: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(folder)
        .args(args)
        .output()
        .map_err(|e| format!("Git indisponível: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr)
            .trim()
            .chars()
            .take(1000)
            .collect());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn native_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

fn project_root(project: &str) -> Result<PathBuf, String> {
    let path = fs::canonicalize(project).map_err(|e| e.to_string())?;
    if !path.is_dir() {
        return Err("Projeto inválido.".into());
    }
    let root = git(&path, &["rev-parse", "--show-toplevel"])?;
    let root = native_path(&fs::canonicalize(root.trim()).map_err(|e| e.to_string())?);
    let path = native_path(&path);
    if root != path {
        return Err("Selecione a raiz do repositório Git.".into());
    }
    Ok(root)
}

fn enqueue(
    path: &Path,
    project: &str,
    agent: &str,
    brief: &str,
    run_id: Option<&str>,
    files: Option<&[String]>,
) -> Result<Worker, String> {
    if !["claude", "codex"].contains(&agent) {
        return Err("Agente deve ser claude ou codex.".into());
    }
    let mut brief = brief.trim().to_string();
    if brief.is_empty() || brief.len() > 32_000 {
        return Err("Brief deve ter entre 1 e 32.000 bytes.".into());
    }
    if let Some(files) = files {
        if files.len() > 100 {
            return Err("Lista de arquivos acima de 100 itens.".into());
        }
        for file in files {
            let path = Path::new(file);
            if path.as_os_str().is_empty()
                || path
                    .components()
                    .any(|part| !matches!(part, std::path::Component::Normal(_)))
            {
                return Err("Arquivos de foco devem ser caminhos relativos ao projeto.".into());
            }
            brief.push_str("\nArquivo de foco: ");
            brief.push_str(file);
        }
    }
    if brief.len() > 32_000 {
        return Err("Brief e lista de arquivos acima de 32.000 bytes.".into());
    }
    let project = project_root(project)?;
    let project_text = project.to_string_lossy().into_owned();
    if !git(&project, &["status", "--porcelain"])?.trim().is_empty() {
        return Err("Limpe ou registre as alterações da branch base antes de delegar.".into());
    }
    let mut connection = db(path)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    let (run_id, base_branch) = if let Some(run) = run_id {
        let base: String = transaction
            .query_row(
                "SELECT base_branch FROM runs WHERE id=?1 AND project=?2",
                params![run, project_text],
                |row| row.get(0),
            )
            .map_err(|_| "Run não encontrado neste projeto.".to_string())?;
        (run.to_string(), base)
    } else {
        let base = git(&project, &["branch", "--show-current"])?
            .trim()
            .to_string();
        if base.is_empty() {
            return Err("A branch base precisa ter um nome.".into());
        }
        let run = uuid::Uuid::new_v4().to_string();
        transaction
            .execute(
                "INSERT INTO runs(id,project,base_branch) VALUES(?1,?2,?3)",
                params![run, project_text, base],
            )
            .map_err(|e| e.to_string())?;
        (run, base)
    };
    let index: i64 = transaction
        .query_row(
            "SELECT COUNT(*)+1 FROM workers WHERE run_id=?1",
            [&run_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let branch = format!("hera/{}-{index}", &run_id[..8]);
    let worktree = project
        .parent()
        .ok_or("Pasta do projeto inválida.")?
        .join(".athenas-worktrees")
        .join(&id);
    git(&project, &["check-ref-format", "--branch", &branch])?;
    let worktree_text = worktree.to_string_lossy().into_owned();
    transaction
        .execute(
            "INSERT INTO workers(id,run_id,project,agent,brief,branch,worktree,status)
        VALUES(?1,?2,?3,?4,?5,?6,?7,'queued')",
            params![
                id,
                run_id,
                project_text,
                agent,
                brief,
                branch,
                worktree_text
            ],
        )
        .map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())?;
    let _ = base_branch;
    list(path, Some(&project_text), Some(&run_id))?
        .into_iter()
        .find(|worker| worker.id == id)
        .ok_or("Worker não encontrado após criação.".into())
}

fn artifacts(worker: &Worker) -> PathBuf {
    Path::new(&worker.project)
        .join(".hera")
        .join("runs")
        .join(&worker.run_id)
        .join(&worker.id)
}

fn ignore_local_artifacts(project: &Path) -> Result<(), String> {
    let exclude = git(project, &["rev-parse", "--git-path", "info/exclude"])?;
    let exclude = PathBuf::from(exclude.trim());
    let exclude = if exclude.is_absolute() {
        exclude
    } else {
        project.join(exclude)
    };
    let existing = fs::read_to_string(&exclude).unwrap_or_default();
    if !existing.lines().any(|line| line.trim() == ".hera/") {
        fs::create_dir_all(exclude.parent().ok_or("Git exclude inválido.")?)
            .map_err(|e| e.to_string())?;
        let mut file = fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(exclude)
            .map_err(|e| e.to_string())?;
        writeln!(file, "\n.hera/").map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn finish(
    path: &Path,
    worker: &Worker,
    status: &str,
    error: Option<String>,
    tokens: Option<i64>,
    cost: Option<f64>,
    files: i64,
    lines: i64,
) {
    if let Ok(connection) = db(path) {
        let _ = connection.execute("UPDATE workers SET status=?2,finished_at=unixepoch(),error=?3,
            tokens=?4,cost_usd=?5,files_changed=?6,lines_changed=?7 WHERE id=?1 AND status='running'",
            params![worker.id,status,error,tokens,cost,files,lines]);
    }
}

struct CliResult {
    text: String,
    tokens: Option<i64>,
    cost: Option<f64>,
    session_id: Option<String>,
    permission_request: Option<String>,
}

fn extract_result(agent: &str, transcript: &str) -> CliResult {
    if agent == "claude" {
        if let Some(value) = transcript
            .lines()
            .rev()
            .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
            .find(|value| value.get("type").and_then(Value::as_str) == Some("result"))
        {
            let result = value
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let tokens = value
                .pointer("/usage/input_tokens")
                .and_then(Value::as_i64)
                .zip(
                    value
                        .pointer("/usage/output_tokens")
                        .and_then(Value::as_i64),
                )
                .map(|(a, b)| a + b);
            let cost = value.get("total_cost_usd").and_then(Value::as_f64);
            let permission_request = value
                .get("permission_denials")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .map(Value::to_string);
            return CliResult {
                text: result,
                tokens,
                cost,
                session_id: value
                    .get("session_id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                permission_request,
            };
        }
    } else {
        let message = transcript
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|value| value.get("type").and_then(Value::as_str) == Some("item.completed"))
            .filter(|value| {
                value.pointer("/item/type").and_then(Value::as_str) == Some("agent_message")
            })
            .filter_map(|value| {
                value
                    .pointer("/item/text")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .last();
        if let Some(message) = message {
            return CliResult {
                text: message,
                tokens: None,
                cost: None,
                session_id: None,
                permission_request: None,
            };
        }
    }
    CliResult {
        text: transcript
            .chars()
            .rev()
            .take(4000)
            .collect::<String>()
            .chars()
            .rev()
            .collect(),
        tokens: None,
        cost: None,
        session_id: None,
        permission_request: None,
    }
}

fn configured_command(configured: &str) -> Result<CommandBuilder, String> {
    let parts = if Path::new(configured).is_file() {
        vec![configured.to_string()]
    } else {
        shell_words::split(configured)
            .map_err(|_| "Comando de agente inválido nas preferências.")?
    };
    let executable = parts
        .first()
        .ok_or("Comando de agente vazio nas preferências.")?;
    if cfg!(windows)
        && [".cmd", ".bat", ".ps1"]
            .iter()
            .any(|suffix| executable.to_ascii_lowercase().ends_with(suffix))
    {
        return Err(
            "Workers exigem um executável direto (.exe); configure o caminho do binário do agente."
                .into(),
        );
    }
    let mut command = CommandBuilder::new(executable);
    for argument in parts.iter().skip(1) {
        command.arg(argument);
    }
    Ok(command)
}

fn worker_command(
    worker: &Worker,
    db_path: &Path,
    preferences: &Preferences,
) -> Result<CommandBuilder, String> {
    let mut command = if worker.agent == "claude" {
        let connection = db(db_path)?;
        let (session_id, allowed, once): (Option<String>, String, String) = connection
            .query_row(
                "SELECT session_id,allowed_tools,once_tools FROM workers WHERE id=?1",
                [&worker.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|e| e.to_string())?;
        let mut tools: Vec<String> = serde_json::from_str(&allowed).map_err(|e| e.to_string())?;
        tools.extend(serde_json::from_str::<Vec<String>>(&once).map_err(|e| e.to_string())?);
        let mut command = if preferences.claude_command == "claude" && cfg!(windows) {
            CommandBuilder::new("claude.exe")
        } else {
            configured_command(&preferences.claude_command)?
        };
        command.args([
            "-p",
            "--output-format",
            "json",
            "--permission-mode",
            "acceptEdits",
            "--permission-prompts",
            "none",
        ]);
        if !tools.is_empty() {
            command.args(["--allowedTools", &tools.join(",")]);
        }
        if let Some(session_id) = session_id {
            command.args([
                "--resume",
                &session_id,
                "Continue a tarefa após a aprovação. Resuma o resultado ao concluir.",
            ]);
        } else {
            command.arg(&worker.brief);
        }
        command
    } else if preferences.codex_command != "codex" {
        let mut command = configured_command(&preferences.codex_command)?;
        command.args([
            "exec",
            "--json",
            "--sandbox",
            "workspace-write",
            &worker.brief,
        ]);
        command
    } else if cfg!(windows) {
        let path = std::env::var_os("PATH").ok_or("PATH não disponível.")?;
        let script = std::env::split_paths(&path)
            .map(|folder| folder.join("node_modules/@openai/codex/bin/codex.js"))
            .find(|candidate| candidate.is_file())
            .ok_or("Codex não encontrado. Instale @openai/codex pelo npm.")?;
        let mut command = CommandBuilder::new("node.exe");
        command.arg(script);
        command.args([
            "exec",
            "--json",
            "--sandbox",
            "workspace-write",
            &worker.brief,
        ]);
        command
    } else {
        let mut command = CommandBuilder::new("codex");
        command.args([
            "exec",
            "--json",
            "--sandbox",
            "workspace-write",
            &worker.brief,
        ]);
        command
    };
    command.cwd(&worker.worktree);
    Ok(command)
}

fn execute(manager: Orchestrator, worker: Worker) {
    let path = manager.db_path.clone();
    let root = Path::new(&worker.project);
    let tree = Path::new(&worker.worktree);
    let dir = artifacts(&worker);
    let outcome = (|| -> Result<(CliResult, i64, i64, bool), String> {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        fs::create_dir_all(tree.parent().ok_or("Worktree inválido.")?)
            .map_err(|e| e.to_string())?;
        ignore_local_artifacts(root)?;
        if tree.exists() {
            if git(tree, &["branch", "--show-current"])?.trim() != worker.branch {
                return Err(
                    "Worktree existente está em outra branch; revise antes de retomar.".into(),
                );
            }
        } else {
            git(
                root,
                &["worktree", "add", "-b", &worker.branch, &worker.worktree],
            )?;
        }
        let executable = if worker.agent == "claude" {
            "Claude Code"
        } else {
            "Codex"
        };
        let preferences = manager.preferences.snapshot()?;
        let command = worker_command(&worker, &path, &preferences)?;
        let argv = command.get_argv();
        let (program, args) = argv.split_first().ok_or("Comando vazio.")?;
        // Headless workers use plain pipes: ConPTY never signals EOF on stdin,
        // which leaves `claude -p` / `codex exec` waiting forever.
        let mut process = Command::new(program);
        process
            .args(args)
            .current_dir(tree)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            process.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = process
            .spawn()
            .map_err(|e| format!("Falha ao iniciar {executable}: {e}"))?;
        manager
            .killers
            .lock()
            .map_err(|e| e.to_string())?
            .insert(worker.id.clone(), Box::new(ProcessKiller(child.id())));
        let mut stdout = child.stdout.take().ok_or("stdout indisponível.")?;
        let mut stderr = child.stderr.take().ok_or("stderr indisponível.")?;
        let log = Arc::new(Mutex::new(
            fs::File::create(dir.join("transcript.log")).map_err(|e| e.to_string())?,
        ));
        let stderr_log = log.clone();
        let stderr_thread = thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            while let Ok(count) = stderr.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                if let Ok(mut file) = stderr_log.lock() {
                    let _ = file.write_all(&buffer[..count]);
                }
            }
        });
        let started = Instant::now();
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            let count = stdout.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            log.lock()
                .map_err(|e| e.to_string())?
                .write_all(&buffer[..count])
                .map_err(|e| e.to_string())?;
            if bytes.len() < 8 * 1024 * 1024 {
                bytes.extend_from_slice(&buffer[..count]);
            }
        }
        let _ = stderr_thread.join();
        let exit = child.wait().map_err(|e| e.to_string())?;
        let transcript = String::from_utf8_lossy(&bytes);
        let result = extract_result(&worker.agent, &transcript);
        git(tree, &["add", "-N", "."])?;
        let diff = git(tree, &["diff", "--binary", "HEAD"])?;
        fs::write(dir.join("diff.patch"), &diff).map_err(|e| e.to_string())?;
        let stat = git(tree, &["diff", "--numstat", "HEAD"])?;
        let files = stat.lines().count() as i64;
        let lines = stat
            .lines()
            .map(|line| {
                line.split('\t')
                    .take(2)
                    .filter_map(|number| number.parse::<i64>().ok())
                    .sum::<i64>()
            })
            .sum();
        fs::write(dir.join("result.md"), &result.text).map_err(|e| e.to_string())?;
        let status = if result.permission_request.is_some() {
            "awaiting_permission"
        } else if exit.success() {
            "completed"
        } else {
            "failed"
        };
        fs::write(dir.join("outcome.json"), serde_json::to_vec_pretty(&json!({
            "status":status,"tokens":result.tokens,"cost_usd":result.cost,"duration_ms":started.elapsed().as_millis(),
            "files_changed":files,"lines_changed":lines,"exit_code":exit.code()
        })).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if !exit.success() && result.permission_request.is_none() {
            return Err(format!(
                "{executable} terminou com código {:?}.",
                exit.code()
            ));
        }
        Ok((result, files, lines, exit.success()))
    })();
    match outcome {
        Ok((result, files, lines, success)) => {
            let waiting = result.permission_request.is_some();
            if let Ok(connection) = db(&path) {
                let _ = connection.execute("UPDATE workers SET session_id=COALESCE(?2,session_id),permission_request=?3 WHERE id=?1",
                    params![worker.id,result.session_id,result.permission_request]);
                let _ = connection.execute(
                    "UPDATE workers SET once_tools='[]' WHERE id=?1",
                    [&worker.id],
                );
            }
            finish(
                &path,
                &worker,
                if waiting {
                    "awaiting_permission"
                } else if success {
                    "completed"
                } else {
                    "failed"
                },
                None,
                result.tokens,
                result.cost,
                files,
                lines,
            );
        }
        Err(error) => {
            let _ = fs::create_dir_all(&dir);
            let _ = fs::write(
                dir.join("outcome.json"),
                serde_json::to_vec_pretty(&json!({"status":"failed","error":error}))
                    .unwrap_or_default(),
            );
            finish(&path, &worker, "failed", Some(error), None, None, 0, 0);
        }
    }
    if let Ok(mut killers) = manager.killers.lock() {
        killers.remove(&worker.id);
    }
}

impl Orchestrator {
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }
    pub fn new(app: &AppHandle, preferences: PreferencesStore) -> Result<Self, String> {
        let path = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("orchestrator.sqlite3");
        let connection = db(&path)?;
        connection.execute("UPDATE workers SET status='interrupted',error='Aplicativo reiniciado; retome o worker.' WHERE status='running'", [])
            .map_err(|e| e.to_string())?;
        Ok(Self {
            db_path: path,
            active: Arc::new(Mutex::new(Vec::new())),
            killers: Arc::new(Mutex::new(HashMap::new())),
            preferences,
        })
    }

    pub fn start(&self) {
        let manager = self.clone();
        thread::spawn(move || loop {
            manager.tick();
            thread::sleep(Duration::from_millis(750));
        });
    }

    fn tick(&self) {
        let Ok(mut active) = self.active.lock() else {
            return;
        };
        let Ok(connection) = db(&self.db_path) else {
            return;
        };
        let waiting: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM workers WHERE status='awaiting_permission'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let limit = self
            .preferences
            .snapshot()
            .map(|prefs| prefs.worker_limit)
            .unwrap_or(3);
        if active.len() + waiting as usize >= limit {
            return;
        }
        let worker = connection.query_row("SELECT id,run_id,project,agent,brief,branch,worktree,status,
        started_at,finished_at,tokens,cost_usd,files_changed,lines_changed,error,permission_request FROM workers
            WHERE status='queued' ORDER BY rowid LIMIT 1", [], worker_from_row).optional().ok().flatten();
        let Some(worker) = worker else { return };
        if connection.execute("UPDATE workers SET status='running',started_at=unixepoch(),error=NULL WHERE id=?1 AND status='queued'", [&worker.id]).ok() != Some(1) { return; }
        active.push(worker.id.clone());
        let manager = self.clone();
        thread::spawn(move || {
            execute(manager.clone(), worker.clone());
            if let Ok(mut active) = manager.active.lock() {
                active.retain(|id| id != &worker.id);
            }
        });
    }
}

#[tauri::command]
pub fn orchestration_list(
    state: tauri::State<'_, Orchestrator>,
    project: Option<String>,
) -> Result<Vec<Worker>, String> {
    list(&state.db_path, project.as_deref(), None)
}

#[tauri::command]
pub fn orchestration_delegate(
    state: tauri::State<'_, Orchestrator>,
    project: String,
    agent: String,
    brief: String,
    run_id: Option<String>,
) -> Result<Worker, String> {
    enqueue(
        &state.db_path,
        &project,
        &agent,
        &brief,
        run_id.as_deref(),
        None,
    )
}

#[tauri::command]
pub fn orchestration_result(
    state: tauri::State<'_, Orchestrator>,
    worker_id: String,
) -> Result<Value, String> {
    let worker = list(&state.db_path, None, None)?
        .into_iter()
        .find(|worker| worker.id == worker_id)
        .ok_or("Worker não encontrado.")?;
    let dir = artifacts(&worker);
    Ok(
        json!({"worker":worker,"result":fs::read_to_string(dir.join("result.md")).unwrap_or_default(),
        "diff":fs::read_to_string(dir.join("diff.patch")).unwrap_or_default(),
        "outcome":fs::read_to_string(dir.join("outcome.json")).unwrap_or_default()}),
    )
}

/// Largest transcript tail sent to the board; older output stays on disk.
const TRANSCRIPT_TAIL_BYTES: u64 = 512 * 1024;

/// Reads the end of a file, dropping a partial first line when it had to cut.
fn read_tail(path: &Path, limit: u64) -> Result<String, String> {
    use std::io::{Seek, SeekFrom};
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(error.to_string()),
    };
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    let start = size.saturating_sub(limit);
    file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if start == 0 {
        return Ok(text);
    }
    Ok(match text.find('\n') {
        Some(index) => text[index + 1..].to_string(),
        None => text,
    })
}

/// Read-only view of a worker's transcript for the board; the leader never receives it.
#[tauri::command]
pub fn orchestration_transcript(
    state: tauri::State<'_, Orchestrator>,
    worker_id: String,
) -> Result<Value, String> {
    let worker = list(&state.db_path, None, None)?
        .into_iter()
        .find(|worker| worker.id == worker_id)
        .ok_or("Worker não encontrado.")?;
    let path = artifacts(&worker).join("transcript.log");
    let size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    Ok(json!({
        "text": read_tail(&path, TRANSCRIPT_TAIL_BYTES)?,
        "truncated": size > TRANSCRIPT_TAIL_BYTES,
    }))
}

#[tauri::command]
pub fn orchestration_resume(
    state: tauri::State<'_, Orchestrator>,
    worker_id: String,
) -> Result<(), String> {
    let connection = db(&state.db_path)?;
    let changed = connection.execute("UPDATE workers SET status='queued',error=NULL,started_at=NULL WHERE id=?1 AND status='interrupted'", [&worker_id]).map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("Apenas workers interrompidos podem ser retomados.".into());
    }
    Ok(())
}

fn decide_permission(path: &Path, worker_id: &str, decision: &str) -> Result<(), String> {
    let connection = db(path)?;
    let (status, request, allowed, once, retries): (String, Option<String>, String, String, i64) = connection.query_row(
        "SELECT status,permission_request,allowed_tools,once_tools,retry_count FROM workers WHERE id=?1",
        [worker_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)))
        .map_err(|_| "Worker não encontrado.".to_string())?;
    if status != "awaiting_permission" {
        return Err("Worker não está aguardando permissão.".into());
    }
    if decision == "deny" || decision == "abort" {
        connection
            .execute(
                "UPDATE workers SET status=?2,error=?3,permission_request=NULL WHERE id=?1",
                params![
                    worker_id,
                    if decision == "deny" {
                        "failed"
                    } else {
                        "aborted"
                    },
                    if decision == "deny" {
                        "Permissão negada pelo usuário."
                    } else {
                        "Worker abortado pelo usuário."
                    }
                ],
            )
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    if decision != "once" && decision != "session" {
        return Err("Decisão inválida.".into());
    }
    if retries >= 5 {
        return Err("Limite de cinco retomadas alcançado. Revise o worker.".into());
    }
    let request: Value = serde_json::from_str(
        request
            .as_deref()
            .ok_or("Pedido de permissão indisponível.")?,
    )
    .map_err(|e| e.to_string())?;
    let tool = request
        .get("tool_name")
        .or_else(|| request.get("toolName"))
        .and_then(Value::as_str)
        .ok_or("Ferramenta solicitada não identificada.")?;
    let rule = if tool == "Bash" {
        let command = request
            .pointer("/tool_input/command")
            .or_else(|| request.pointer("/toolInput/command"))
            .and_then(Value::as_str)
            .ok_or("Comando solicitado não identificado.")?;
        if command
            .chars()
            .any(|ch| ch == '\0' || ch == '\n' || ch == '\r')
        {
            return Err("Comando de múltiplas linhas exige revisão fora do board.".into());
        }
        format!("Bash({command})")
    } else {
        tool.to_string()
    };
    let mut list: Vec<String> =
        serde_json::from_str(if decision == "once" { &once } else { &allowed })
            .map_err(|e| e.to_string())?;
    if !list.contains(&rule) {
        list.push(rule);
    }
    connection
        .execute(
            &format!(
                "UPDATE workers SET {},status='queued',permission_request=NULL,
        retry_count=retry_count+1,error=NULL WHERE id=?1",
                if decision == "once" {
                    "once_tools=?2"
                } else {
                    "allowed_tools=?2"
                }
            ),
            params![
                worker_id,
                serde_json::to_string(&list).map_err(|e| e.to_string())?
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn orchestration_permission(
    state: tauri::State<'_, Orchestrator>,
    worker_id: String,
    decision: String,
) -> Result<(), String> {
    decide_permission(&state.db_path, &worker_id, &decision)
}

#[tauri::command]
pub fn orchestration_abort(
    state: tauri::State<'_, Orchestrator>,
    worker_id: String,
) -> Result<(), String> {
    let connection = db(&state.db_path)?;
    let changed = connection.execute("UPDATE workers SET status='aborted',error='Abortado pelo usuário.',
        finished_at=unixepoch(),permission_request=NULL WHERE id=?1 AND status IN ('queued','running','interrupted','awaiting_permission')",
        [&worker_id]).map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("Worker não pode ser abortado neste estado.".into());
    }
    if let Some(killer) = state
        .killers
        .lock()
        .map_err(|e| e.to_string())?
        .get_mut(&worker_id)
    {
        killer.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn land(path: &Path, worker_id: &str) -> Result<String, String> {
    let worker = list(path, None, None)?
        .into_iter()
        .find(|worker| worker.id == worker_id)
        .ok_or("Worker não encontrado.")?;
    if worker.status != "completed" {
        return Err("Apenas um worker concluído pode ser aterrissado.".into());
    }
    let connection = db(path)?;
    let base: String = connection
        .query_row(
            "SELECT base_branch FROM runs WHERE id=?1",
            [&worker.run_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let project = Path::new(&worker.project);
    let tree = Path::new(&worker.worktree);
    if git(project, &["branch", "--show-current"])?.trim() != base {
        return Err(format!(
            "Volte para a branch base {base} antes de aterrissar."
        ));
    }
    if !git(project, &["status", "--porcelain"])?.trim().is_empty() {
        return Err(
            "A branch base tem alterações locais. Registre ou guarde antes do merge.".into(),
        );
    }
    if git(tree, &["branch", "--show-current"])?.trim() != worker.branch {
        return Err("O worktree mudou de branch. Revise antes de aterrissar.".into());
    }
    git(tree, &["add", "-A"])?;
    let staged = git(tree, &["diff", "--cached", "--name-only"])?;
    if !staged.trim().is_empty() {
        git(
            tree,
            &[
                "commit",
                "-m",
                &format!("feat: land worker {}", &worker.id[..8]),
            ],
        )?;
    }
    let merge = git(project, &["merge", "--no-ff", "--no-edit", &worker.branch]);
    if let Err(error) = merge {
        let _ = git(project, &["merge", "--abort"]);
        return Err(format!(
            "Conflito no merge; a branch e o worktree foram preservados. {error}"
        ));
    }
    connection
        .execute(
            "UPDATE workers SET status='landed',error=NULL WHERE id=?1",
            [&worker.id],
        )
        .map_err(|e| e.to_string())?;
    git(project, &["worktree", "remove", &worker.worktree])?;
    git(project, &["branch", "-d", &worker.branch])?;
    Ok(format!("Worker {} integrado em {base}.", &worker.id[..8]))
}

#[tauri::command]
pub fn orchestration_land(
    state: tauri::State<'_, Orchestrator>,
    worker_id: String,
) -> Result<String, String> {
    land(&state.db_path, &worker_id)
}

fn mcp_tools() -> Value {
    json!({"tools":[
        {"name":"hera_delegate","description":"Delega uma tarefa a um worker Claude ou Codex em git worktree isolado.",
         "inputSchema":{"type":"object","properties":{"agent":{"type":"string","enum":["claude","codex"]},
         "brief":{"type":"string"},"run_id":{"type":"string"},"worktree":{"type":"boolean"},"files":{"type":"array","items":{"type":"string"}}},
         "required":["agent","brief"]}},
        {"name":"hera_status","description":"Lista o estado dos workers de um run ou projeto.",
         "inputSchema":{"type":"object","properties":{"run_id":{"type":"string"}}}},
        {"name":"hera_result","description":"Lê o resultado, resumo do diff e métricas de um worker concluído.",
         "inputSchema":{"type":"object","properties":{"worker_id":{"type":"string"}},"required":["worker_id"]}},
        {"name":"hera_quota","description":"Retorna os dados de quota disponíveis sem estimar valores não fornecidos pelos CLIs.",
         "inputSchema":{"type":"object","properties":{}}}
    ]})
}

fn mcp_call(db_path: &Path, project: &str, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "hera_delegate" => {
            if args.get("worktree").and_then(Value::as_bool) == Some(false) {
                return Err("Workers sempre usam um worktree isolado.".into());
            }
            let agent = args
                .get("agent")
                .and_then(Value::as_str)
                .ok_or("agent obrigatório.")?;
            let brief = args
                .get("brief")
                .and_then(Value::as_str)
                .ok_or("brief obrigatório.")?;
            let run = args.get("run_id").and_then(Value::as_str);
            let files = args
                .get("files")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .map(|item| {
                            item.as_str()
                                .map(str::to_string)
                                .ok_or("files deve conter apenas strings.")
                        })
                        .collect::<Result<Vec<_>, _>>()
                })
                .transpose()?;
            Ok(json!(enqueue(
                db_path,
                project,
                agent,
                brief,
                run,
                files.as_deref()
            )?))
        }
        "hera_status" => Ok(json!(list(
            db_path,
            Some(project),
            args.get("run_id").and_then(Value::as_str)
        )?)),
        "hera_result" => {
            let id = args
                .get("worker_id")
                .and_then(Value::as_str)
                .ok_or("worker_id obrigatório.")?;
            let worker = list(db_path, Some(project), None)?
                .into_iter()
                .find(|worker| worker.id == id)
                .ok_or("Worker não encontrado neste projeto.")?;
            let dir = artifacts(&worker);
            let diff = fs::read_to_string(dir.join("diff.patch")).unwrap_or_default();
            Ok(
                json!({"worker":worker,"result":fs::read_to_string(dir.join("result.md")).unwrap_or_default(),
                "diff_summary":diff.lines().filter(|line| line.starts_with("diff --git ")).take(100).collect::<Vec<_>>(),
                "outcome":fs::read_to_string(dir.join("outcome.json")).unwrap_or_default()}),
            )
        }
        "hera_quota" => Ok(
            json!({"claude":null,"codex":null,"message":"Quotas não disponíveis pelos CLIs nesta sessão."}),
        ),
        _ => Err("Ferramenta desconhecida.".into()),
    }
}

pub fn run_mcp_stdio(db_path: &Path, project: &str) -> Result<(), String> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let Some(id) = request.get("id") else {
            continue;
        };
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let result = match method {
            "initialize" => json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}},
                "serverInfo":{"name":"athenas-orchestrator","version":env!("CARGO_PKG_VERSION")}}),
            "tools/list" => mcp_tools(),
            "tools/call" => {
                let params = request.get("params").cloned().unwrap_or_default();
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let args = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                match mcp_call(db_path, project, name, &args) {
                    Ok(value) => json!({"content":[{"type":"text","text":value.to_string()}]}),
                    Err(error) => json!({"content":[{"type":"text","text":error}],"isError":true}),
                }
            }
            _ => {
                let response = json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}});
                writeln!(stdout, "{response}").map_err(|e| e.to_string())?;
                stdout.flush().map_err(|e| e.to_string())?;
                continue;
            }
        };
        let response = json!({"jsonrpc":"2.0","id":id,"result":result});
        writeln!(stdout, "{response}").map_err(|e| e.to_string())?;
        stdout.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_tail_keeps_whole_lines() {
        let path = std::env::temp_dir().join(format!("athenas-tail-{}.log", uuid::Uuid::new_v4()));
        assert_eq!(read_tail(&path, 10).unwrap(), "");
        fs::write(&path, "first line\nsecond\nthird\n").unwrap();
        assert_eq!(read_tail(&path, 1024).unwrap(), "first line\nsecond\nthird\n");
        assert_eq!(read_tail(&path, 10).unwrap(), "third\n");
        fs::remove_file(&path).unwrap();
    }

    fn repo() -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("athenas-orchestrator-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q"]).unwrap();
        git(&root, &["config", "user.name", "Athenas Test"]).unwrap();
        git(&root, &["config", "user.email", "test@localhost"]).unwrap();
        fs::write(root.join("base.txt"), "base\n").unwrap();
        git(&root, &["add", "base.txt"]).unwrap();
        git(&root, &["commit", "-qm", "base"]).unwrap();
        root
    }

    #[test]
    fn delegates_two_workers_and_lands_one_without_losing_the_other() {
        let root = repo();
        // Keep the test database outside the Git worktree, as the installed app does.
        let path = root
            .parent()
            .unwrap()
            .join(format!("athenas-test-{}.sqlite3", uuid::Uuid::new_v4()));
        let project = fs::canonicalize(&root)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let first = enqueue(&path, &project, "claude", "Create file one", None, None).unwrap();
        let second = enqueue(
            &path,
            &project,
            "codex",
            "Create file two",
            Some(&first.run_id),
            None,
        )
        .unwrap();
        assert_ne!(first.worktree, second.worktree);
        assert_eq!(
            list(&path, Some(&project), Some(&first.run_id))
                .unwrap()
                .len(),
            2
        );
        fs::create_dir_all(Path::new(&first.worktree).parent().unwrap()).unwrap();
        git(
            &root,
            &["worktree", "add", "-b", &first.branch, &first.worktree],
        )
        .unwrap();
        fs::write(Path::new(&first.worktree).join("one.txt"), "one\n").unwrap();
        db(&path)
            .unwrap()
            .execute(
                "UPDATE workers SET status='completed' WHERE id=?1",
                [&first.id],
            )
            .unwrap();
        ignore_local_artifacts(&root).unwrap();
        assert!(land(&path, &first.id).unwrap().contains("integrado"));
        assert_eq!(
            fs::read_to_string(root.join("one.txt")).unwrap().trim(),
            "one"
        );
        assert_eq!(
            list(&path, Some(&project), Some(&first.run_id))
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            list(&path, Some(&project), Some(&first.run_id)).unwrap()[1].status,
            "landed"
        );
        // The unlanded worker and its queue record remain available.
        assert!(list(&path, Some(&project), None)
            .unwrap()
            .iter()
            .any(|worker| worker.id == second.id && worker.status == "queued"));
        fs::remove_dir_all(root).unwrap();
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn permission_decision_requeues_with_exact_command_and_preserves_denials() {
        let root = repo();
        let path = root
            .parent()
            .unwrap()
            .join(format!("athenas-test-{}.sqlite3", uuid::Uuid::new_v4()));
        let project = root.to_string_lossy().into_owned();
        let worker = enqueue(&path, &project, "claude", "Run tests", None, None).unwrap();
        let request = json!({"tool_name":"Bash","tool_input":{"command":"npm test"}}).to_string();
        db(&path)
            .unwrap()
            .execute(
                "UPDATE workers SET status='awaiting_permission',permission_request=?2 WHERE id=?1",
                params![worker.id, request],
            )
            .unwrap();
        decide_permission(&path, &worker.id, "once").unwrap();
        let connection = db(&path).unwrap();
        let (status, once): (String, String) = connection
            .query_row(
                "SELECT status,once_tools FROM workers WHERE id=?1",
                [&worker.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "queued");
        assert_eq!(
            serde_json::from_str::<Vec<String>>(&once).unwrap(),
            vec!["Bash(npm test)"]
        );
        assert!(decide_permission(&path, &worker.id, "session").is_err());
        drop(connection);
        fs::remove_dir_all(root).unwrap();
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn claude_result_reports_real_usage_and_permission_request() {
        let transcript = json!({"type":"result","result":"Preciso rodar os testes.",
            "session_id":"abc-123","usage":{"input_tokens":12,"output_tokens":8},
            "total_cost_usd":0.002,"permission_denials":[{"tool_name":"Bash",
            "tool_input":{"command":"npm test"}}]})
        .to_string();
        let result = extract_result("claude", &transcript);
        assert_eq!(result.tokens, Some(20));
        assert_eq!(result.cost, Some(0.002));
        assert_eq!(result.session_id.as_deref(), Some("abc-123"));
        assert!(result.permission_request.unwrap().contains("npm test"));
    }

    #[cfg(windows)]
    #[test]
    fn piped_worker_with_null_stdin_exits_without_pty() {
        let output = Command::new("cmd.exe")
            .args(["/d", "/c", "more > nul & echo ATHENAS_DONE"])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("ATHENAS_DONE"));
    }
}
