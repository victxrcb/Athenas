import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { providerName, type RepoInfo } from './GitRemote';

/** Optional repository link for a project, with the folder's `origin` offered as a shortcut. */
export function RepoField({ value, onChange, folder }: { value: string; onChange: (value: string) => void; folder: string }) {
  const [origin, setOrigin] = useState<string | null>(null);
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri() || !folder.trim()) { setOrigin(null); return; }
    let alive = true;
    const timer = window.setTimeout(() => {
      void invoke<string | null>('git_origin_url', { folder }).then((url) => { if (alive) setOrigin(url); }).catch(() => { if (alive) setOrigin(null); });
    }, 300);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [folder]);

  useEffect(() => {
    if (!isTauri() || !value.trim()) { setInfo(null); setError(null); return; }
    let alive = true;
    void invoke<RepoInfo>('git_repo_info', { url: value })
      .then((repo) => { if (alive) { setInfo(repo); setError(null); } })
      .catch((reason) => { if (alive) { setInfo(null); setError(String(reason)); } });
    return () => { alive = false; };
  }, [value]);

  return <label className="form-field"><span>Repositório <small className="field-optional">opcional</small></span>
    <input value={value} onChange={(event) => onChange(event.target.value)} placeholder="https://github.com/dono/repositorio" spellCheck={false} aria-label="Repositório" aria-invalid={error ? true : undefined} />
    {error ? <small className="field-hint error">{error}</small>
      : info ? <small className="field-hint">{providerName(info.provider)} · {info.slug}</small>
      : <small className="field-hint">Link do repositório Git. Usado na aba Git para acompanhar branches e pull requests.</small>}
    {origin && origin !== value.trim() && <button type="button" className="button-quiet button-sm repo-origin" onClick={() => onChange(origin)}>Usar origin: <code>{origin}</code></button>}
  </label>;
}
