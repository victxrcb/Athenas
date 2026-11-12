use serde::Serialize;
use serde_json::Value;
use std::{fs, path::PathBuf, time::Duration};

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    used_percent: f64,
    resets_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentQuota {
    agent: &'static str,
    five_hour: Option<UsageWindow>,
    weekly: Option<UsageWindow>,
    error: Option<String>,
}

fn window(percent: Option<f64>, reset: Option<String>) -> Option<UsageWindow> {
    let used_percent =
        percent.filter(|value| value.is_finite() && (0.0..=100.0).contains(value))?;
    Some(UsageWindow {
        used_percent,
        resets_at: reset,
    })
}

fn unix_reset(value: &Value) -> Option<String> {
    value.as_i64().map(|seconds| (seconds * 1000).to_string())
}

fn claude_reset(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_owned)
        .or_else(|| unix_reset(value))
}

fn claude_windows(value: &Value) -> (Option<UsageWindow>, Option<UsageWindow>) {
    let parse = |key: &str| {
        let data = &value[key];
        window(
            data["utilization"].as_f64().map(|percent| {
                if percent <= 1.0 {
                    percent * 100.0
                } else {
                    percent
                }
            }),
            claude_reset(&data["resets_at"]),
        )
    };
    let mut five_hour = parse("five_hour");
    let mut weekly = parse("seven_day");
    if let Some(limits) = value["limits"].as_array() {
        for limit in limits {
            let parsed = window(limit["percent"].as_f64(), claude_reset(&limit["resets_at"]));
            match limit["kind"].as_str() {
                Some("session") => five_hour = parsed.or(five_hour),
                Some("weekly_all") => weekly = parsed.or(weekly),
                _ => {}
            }
        }
    }
    (five_hour, weekly)
}

fn codex_windows(value: &Value) -> (Option<UsageWindow>, Option<UsageWindow>) {
    let mut five_hour = None;
    let mut weekly = None;
    for key in ["primary_window", "secondary_window"] {
        let data = &value["rate_limit"][key];
        let duration = data["limit_window_seconds"].as_u64();
        let parsed = window(data["used_percent"].as_f64(), unix_reset(&data["reset_at"]));
        match duration {
            Some(18000) => five_hour = parsed,
            Some(604800) => weekly = parsed,
            _ => {}
        }
    }
    (five_hour, weekly)
}

fn home_file(parts: &[&str]) -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    let mut path = PathBuf::from(home);
    for part in parts {
        path.push(part);
    }
    Some(path)
}

fn credentials(parts: &[&str]) -> Result<Value, String> {
    let path = home_file(parts).ok_or("Pasta do usuário indisponível")?;
    let bytes =
        fs::read(path).map_err(|_| "Faça login na CLI para consultar a cota".to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "Credenciais da CLI inválidas".to_string())
}

async fn fetch(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    account: Option<&str>,
) -> Result<Value, String> {
    let mut request = client
        .get(url)
        .bearer_auth(token)
        .header("Accept", "application/json");
    if url.contains("anthropic.com") {
        request = request.header("anthropic-beta", "oauth-2025-04-20");
    }
    if let Some(account) = account {
        request = request.header("ChatGPT-Account-Id", account);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "Não foi possível consultar a cota".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Consulta da cota retornou HTTP {}",
            response.status().as_u16()
        ));
    }
    response
        .json()
        .await
        .map_err(|_| "Resposta da cota inválida".to_string())
}

async fn claude(client: &reqwest::Client) -> AgentQuota {
    let result = async {
        let auth = credentials(&[".claude", ".credentials.json"])?;
        let token = auth["claudeAiOauth"]["accessToken"]
            .as_str()
            .ok_or("Faça login no Claude Code")?;
        let value = fetch(
            client,
            "https://api.anthropic.com/api/oauth/usage",
            token,
            None,
        )
        .await?;
        Ok::<_, String>(claude_windows(&value))
    }
    .await;
    quota("Claude Code", result)
}

async fn codex(client: &reqwest::Client) -> AgentQuota {
    let result = async {
        let auth = credentials(&[".codex", "auth.json"])?;
        let token = auth["tokens"]["access_token"]
            .as_str()
            .ok_or("Faça login no Codex com ChatGPT")?;
        let account = auth["tokens"]["account_id"].as_str();
        let value = fetch(
            client,
            "https://chatgpt.com/backend-api/wham/usage",
            token,
            account,
        )
        .await?;
        Ok::<_, String>(codex_windows(&value))
    }
    .await;
    quota("Codex", result)
}

fn quota(
    agent: &'static str,
    result: Result<(Option<UsageWindow>, Option<UsageWindow>), String>,
) -> AgentQuota {
    match result {
        Ok((five_hour, weekly)) => AgentQuota {
            agent,
            five_hour,
            weekly,
            error: None,
        },
        Err(error) => AgentQuota {
            agent,
            five_hour: None,
            weekly: None,
            error: Some(error),
        },
    }
}

#[tauri::command]
pub async fn agent_quotas() -> Vec<AgentQuota> {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            return vec![
                quota("Claude Code", Err("Cliente HTTP indisponível".into())),
                quota("Codex", Err("Cliente HTTP indisponível".into())),
            ]
        }
    };
    vec![claude(&client).await, codex(&client).await]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_classifies_windows_by_duration() {
        let value = serde_json::json!({"rate_limit": {"primary_window": {"used_percent": 21, "limit_window_seconds": 604800, "reset_at": 1800000000}, "secondary_window": {"used_percent": 8, "limit_window_seconds": 18000, "reset_at": 1799500000}}});
        let (five, week) = codex_windows(&value);
        assert_eq!(five.unwrap().used_percent, 8.0);
        assert_eq!(week.unwrap().resets_at.as_deref(), Some("1800000000000"));
    }

    #[test]
    fn codex_weekly_only_does_not_masquerade_as_five_hour() {
        let value = serde_json::json!({"rate_limit": {"primary_window": {"used_percent": 42, "limit_window_seconds": 604800, "reset_at": 1800000000}}});
        let (five, week) = codex_windows(&value);
        assert!(five.is_none());
        assert_eq!(week.unwrap().used_percent, 42.0);
    }

    #[test]
    fn claude_uses_backend_percent_without_scaling() {
        let value = serde_json::json!({"five_hour": {"utilization": 0.345, "resets_at": "2026-11-12T20:00:00Z"}, "seven_day": {"utilization": 0.7}});
        let (five, week) = claude_windows(&value);
        assert_eq!(five.unwrap().used_percent, 34.5);
        assert_eq!(week.unwrap().used_percent, 70.0);
    }

    #[test]
    fn claude_accepts_new_limits_array() {
        let value = serde_json::json!({"limits": [{"kind": "session", "percent": 19.0, "resets_at": 1800000000}, {"kind": "weekly_all", "percent": 32.0, "resets_at": "2026-11-18T00:00:00Z"}]});
        let (five, week) = claude_windows(&value);
        assert_eq!(five.unwrap().used_percent, 19.0);
        assert_eq!(week.unwrap().used_percent, 32.0);
    }
}
