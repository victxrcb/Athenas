use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyTrack {
    title: String,
    artist: String,
    album: String,
    is_playing: bool,
}

#[cfg(windows)]
mod platform {
    use super::SpotifyTrack;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
    };

    fn spotify_source(source: &str) -> bool {
        source.to_ascii_lowercase().contains("spotify")
    }

    async fn session() -> Result<Option<Session>, String> {
        let manager = Manager::RequestAsync()
            .map_err(|error| error.to_string())?
            .await
            .map_err(|error| error.to_string())?;
        let sessions = manager.GetSessions().map_err(|error| error.to_string())?;
        let mut paused = None;
        for index in 0..sessions.Size().map_err(|error| error.to_string())? {
            let candidate = sessions.GetAt(index).map_err(|error| error.to_string())?;
            let source = candidate
                .SourceAppUserModelId()
                .map_err(|error| error.to_string())?;
            if !spotify_source(&source.to_string()) {
                continue;
            }
            let playing = candidate
                .GetPlaybackInfo()
                .and_then(|info| info.PlaybackStatus())
                .is_ok_and(|status| status == PlaybackStatus::Playing);
            if playing {
                return Ok(Some(candidate));
            }
            paused = Some(candidate);
        }
        Ok(paused)
    }

    pub async fn status() -> Result<Option<SpotifyTrack>, String> {
        let Some(session) = session().await? else {
            return Ok(None);
        };
        let properties = session
            .TryGetMediaPropertiesAsync()
            .map_err(|error| error.to_string())?
            .await
            .map_err(|error| error.to_string())?;
        let playback = session
            .GetPlaybackInfo()
            .map_err(|error| error.to_string())?;
        Ok(Some(SpotifyTrack {
            title: properties
                .Title()
                .map_err(|error| error.to_string())?
                .to_string(),
            artist: properties
                .Artist()
                .map_err(|error| error.to_string())?
                .to_string(),
            album: properties
                .AlbumTitle()
                .map_err(|error| error.to_string())?
                .to_string(),
            is_playing: playback
                .PlaybackStatus()
                .map_err(|error| error.to_string())?
                == PlaybackStatus::Playing,
        }))
    }

    pub async fn control(action: &str) -> Result<Option<SpotifyTrack>, String> {
        let Some(session) = session().await? else {
            return Err("Spotify não está disponível nas sessões de mídia do Windows.".into());
        };
        let operation = match action {
            "previous" => session.TrySkipPreviousAsync(),
            "toggle" => session.TryTogglePlayPauseAsync(),
            "next" => session.TrySkipNextAsync(),
            _ => return Err("Comando de reprodução inválido.".into()),
        }
        .map_err(|error| error.to_string())?;
        if !operation.await.map_err(|error| error.to_string())? {
            return Err("O Spotify não aceitou o comando de reprodução.".into());
        }
        status().await
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn identifies_only_spotify_sessions() {
            assert!(spotify_source("Spotify.exe"));
            assert!(spotify_source("SpotifyAB.SpotifyMusic_zpdnekdrzrea0"));
            assert!(!spotify_source("chrome.exe"));
        }
    }
}

#[tauri::command]
pub async fn spotify_status() -> Result<Option<SpotifyTrack>, String> {
    #[cfg(windows)]
    {
        platform::status().await
    }
    #[cfg(not(windows))]
    {
        Err("O controle do Spotify está disponível apenas no Windows.".into())
    }
}

#[tauri::command]
pub async fn spotify_control(action: String) -> Result<Option<SpotifyTrack>, String> {
    #[cfg(windows)]
    {
        platform::control(&action).await
    }
    #[cfg(not(windows))]
    {
        let _ = action;
        Err("O controle do Spotify está disponível apenas no Windows.".into())
    }
}
