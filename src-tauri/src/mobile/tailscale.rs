//! Talks to the installed Tailscale: whether this computer is on the private network, and publishing the
//! local server there with `tailscale serve`. It never enables Funnel, which would expose it to the internet.
use serde::Serialize;
use serde_json::Value;
use std::{
    io::Read,
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub const TIMEOUT: Duration = Duration::from_secs(15);
const HTTPS_PORT: &str = "443";

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub installed: bool,
    pub running: bool,
    /// Whether the account allows HTTPS certificates for this computer.
    pub https: bool,
    pub dns_name: Option<String>,
}

fn executable() -> Option<PathBuf> {
    let name = if cfg!(windows) { "tailscale.exe" } else { "tailscale" };
    let in_path = std::env::var_os("PATH").and_then(|path| std::env::split_paths(&path).map(|folder| folder.join(name)).find(|file| file.is_file()));
    in_path.or_else(|| {
        let usual: &[&str] = if cfg!(windows) {
            &[r"C:\Program Files\Tailscale\tailscale.exe"]
        } else if cfg!(target_os = "macos") {
            &["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"]
        } else {
            &["/usr/bin/tailscale", "/usr/local/bin/tailscale"]
        };
        usual.iter().map(PathBuf::from).find(|file| file.is_file())
    })
}

/// Runs the CLI with a deadline: `serve` waits forever when it wants something enabled in the browser.
fn run(arguments: &[&str], deadline: Duration) -> Result<String, String> {
    let program = executable().ok_or("O Tailscale não está instalado.")?;
    let mut command = Command::new(program);
    command.args(arguments).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().map_err(|error| format!("Não foi possível executar o Tailscale: {error}"))?;
    let collect = |pipe: Option<Box<dyn Read + Send>>| {
        thread::spawn(move || {
            let mut text = String::new();
            if let Some(pipe) = pipe {
                let _ = pipe.take(1024 * 1024).read_to_string(&mut text);
            }
            text
        })
    };
    let output = collect(child.stdout.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>));
    let errors = collect(child.stderr.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>));
    let started = Instant::now();
    let exit = loop {
        if let Some(exit) = child.try_wait().map_err(|error| error.to_string())? {
            break Some(exit);
        }
        if started.elapsed() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        thread::sleep(Duration::from_millis(50));
    };
    let (output, errors) = (output.join().unwrap_or_default(), errors.join().unwrap_or_default());
    match exit {
        Some(exit) if exit.success() => Ok(output),
        Some(_) => Err(format!("O Tailscale recusou o comando: {}", last_lines(&format!("{output}\n{errors}")))),
        None => Err(format!("O Tailscale não respondeu a tempo. {}", last_lines(&format!("{output}\n{errors}")))),
    }
}

fn last_lines(text: &str) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    lines[lines.len().saturating_sub(4)..].join(" ")
}

fn parse_status(json: &Value) -> Status {
    let dns_name = json.pointer("/Self/DNSName").and_then(Value::as_str).map(|name| name.trim_end_matches('.').to_lowercase()).filter(|name| !name.is_empty());
    let https = json.get("CertDomains").and_then(Value::as_array).is_some_and(|domains| {
        domains.iter().filter_map(Value::as_str).any(|domain| Some(domain.to_lowercase()) == dns_name)
    });
    Status { installed: true, running: json.get("BackendState").and_then(Value::as_str) == Some("Running"), https, dns_name }
}

pub fn status() -> Status {
    if executable().is_none() {
        return Status::default();
    }
    run(&["status", "--json"], TIMEOUT)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .map(|json| parse_status(&json))
        .unwrap_or(Status { installed: true, ..Status::default() })
}

/// The address phones use, or why there is none yet.
pub fn ready(status: &Status) -> Result<String, String> {
    if !status.installed {
        return Err("Instale o Tailscale neste computador.".into());
    }
    if !status.running {
        return Err("Abra o Tailscale e entre na sua conta.".into());
    }
    if !status.https {
        return Err("Ative HTTPS Certificates na página DNS do painel do Tailscale.".into());
    }
    status.dns_name.clone().ok_or_else(|| "Ative o MagicDNS na página DNS do painel do Tailscale.".into())
}

/// What currently uses HTTPS port 443 on this computer's Tailscale name.
#[derive(Debug, PartialEq)]
enum Port {
    Free,
    Ours,
    Taken,
}

fn proxy_for(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn inspect(config: &Value, port: u16) -> Port {
    let suffix = format!(":{HTTPS_PORT}");
    let entries = |key: &str| config.get(key).and_then(Value::as_object).into_iter().flatten();
    // A Funnel left on this port would publish whatever we serve to the whole internet.
    if entries("AllowFunnel").any(|(name, on)| name.ends_with(&suffix) && on.as_bool() == Some(true)) {
        return Port::Taken;
    }
    let sites: Vec<&Value> = entries("Web").filter(|(name, _)| name.ends_with(&suffix)).map(|(_, site)| site).collect();
    if sites.is_empty() {
        return if config.pointer(&format!("/TCP/{HTTPS_PORT}")).is_some() { Port::Taken } else { Port::Free };
    }
    let ours = sites.iter().all(|site| {
        site.get("Handlers").and_then(Value::as_object).is_some_and(|handlers| {
            handlers.len() == 1 && handlers.get("/").and_then(|root| root.get("Proxy")).and_then(Value::as_str) == Some(proxy_for(port).as_str())
        })
    });
    if ours { Port::Ours } else { Port::Taken }
}

fn serve_config(deadline: Duration) -> Result<Value, String> {
    let text = run(&["serve", "status", "--json"], deadline)?;
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|_| "Não foi possível ler a configuração do Tailscale Serve.".into())
}

/// Publishes the local server on the private network. Refuses to replace something else the user serves.
pub fn publish(port: u16) -> Result<(), String> {
    if inspect(&serve_config(TIMEOUT)?, port) == Port::Taken {
        return Err("A porta 443 do Tailscale Serve já está em uso por outra configuração. Confira com `tailscale serve status`.".into());
    }
    run(&["serve", "--bg", &format!("--https={HTTPS_PORT}"), &proxy_for(port)], TIMEOUT)?;
    match inspect(&serve_config(TIMEOUT)?, port) {
        Port::Ours => Ok(()),
        _ => Err("O Tailscale não registrou a publicação.".into()),
    }
}

/// Removes our publication, and only ours.
pub fn unpublish(port: u16, deadline: Duration) -> Result<(), String> {
    if inspect(&serve_config(deadline)?, port) == Port::Ours {
        run(&["serve", &format!("--https={HTTPS_PORT}"), "off"], deadline)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn status_says_what_is_missing() {
        let full = json!({ "BackendState": "Running", "Self": { "DNSName": "PC.tail1.ts.net." }, "CertDomains": ["pc.tail1.ts.net"] });
        let status = parse_status(&full);
        assert_eq!(ready(&status), Ok("pc.tail1.ts.net".to_string()));
        let no_https = parse_status(&json!({ "BackendState": "Running", "Self": { "DNSName": "pc.tail1.ts.net." }, "CertDomains": null }));
        assert!(ready(&no_https).unwrap_err().contains("HTTPS"));
        let stopped = parse_status(&json!({ "BackendState": "Stopped" }));
        assert!(ready(&stopped).unwrap_err().contains("conta"));
        assert!(ready(&Status::default()).unwrap_err().contains("Instale"));
    }

    #[test]
    fn other_serve_setups_are_never_replaced_or_removed() {
        let site = |proxy: &str| json!({ "TCP": { "443": { "HTTPS": true } }, "Web": { "pc.ts.net:443": { "Handlers": { "/": { "Proxy": proxy } } } } });
        assert_eq!(inspect(&Value::Null, 47821), Port::Free);
        assert_eq!(inspect(&json!({}), 47821), Port::Free);
        assert_eq!(inspect(&site("http://127.0.0.1:47821"), 47821), Port::Ours);
        assert_eq!(inspect(&site("http://127.0.0.1:3000"), 47821), Port::Taken);
        assert_eq!(inspect(&json!({ "TCP": { "443": { "TCPForward": "127.0.0.1:22" } } }), 47821), Port::Taken);
        let mut funnel = site("http://127.0.0.1:47821");
        funnel["AllowFunnel"] = json!({ "pc.ts.net:443": true });
        assert_eq!(inspect(&funnel, 47821), Port::Taken);
        let other_port = json!({ "TCP": { "8443": { "HTTPS": true } }, "Web": { "pc.ts.net:8443": { "Handlers": {} } } });
        assert_eq!(inspect(&other_port, 47821), Port::Free);
    }
}
