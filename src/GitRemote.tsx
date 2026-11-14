import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ExternalLink, GitPullRequest, RefreshCw, Search } from 'lucide-react';
import { Select } from './Select';

export type RepoInfo = { provider: 'github' | 'azure' | 'gitlab' | 'bitbucket' | 'other'; host: string; slug: string; name: string; webUrl: string; pullsUrl: string; newPullUrl: string };
export type RemoteBranch = { name: string; sha: string; date: string | null; author: string | null; subject: string | null; local: string | null; ahead: number; behind: number; current: boolean };
export type RemoteBranches = { remote: string | null; defaultBranch: string | null; branches: RemoteBranch[]; fetchError: string | null };
type PullRequest = { number: number; title: string; url: string; headRefName: string; baseRefName: string; isDraft: boolean; createdAt: string; author: string | null; reviewDecision: string | null };
type PullRequests = { defaultBranch: string | null; items: PullRequest[] };

const PROVIDERS: Record<string, string> = { github: 'GitHub', azure: 'Azure DevOps', gitlab: 'GitLab', bitbucket: 'Bitbucket', other: 'Git' };
export const providerName = (provider: string) => PROVIDERS[provider] ?? 'Git';
export const openUrl = (url: string) => invoke('git_open_url', { url });

const REVIEW: Record<string, string> = { APPROVED: 'Aprovado', CHANGES_REQUESTED: 'Alterações pedidas', REVIEW_REQUIRED: 'Revisão pendente' };

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '';
  const seconds = Math.round((time - now) / 1000);
  const format = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3_600], ['minute', 60]];
  for (const [unit, size] of steps) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return 'agora';
}

/** Remote branches of the project's repository. Shows the cached refs first, then fetches. */
export function useRemoteBranches(folder: string | null, url: string | null) {
  const [data, setData] = useState<RemoteBranches | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const load = useCallback(async (fetch: boolean) => {
    if (!url) return null;
    const id = ++request.current;
    setLoading(true);
    try {
      const result = await invoke<RemoteBranches>('git_remote_branches', { folder, url, fetch });
      if (id === request.current) { setData(result); setError(null); }
      return result;
    } catch (reason) {
      if (id === request.current) setError(String(reason));
      return null;
    } finally { if (id === request.current) setLoading(false); }
  }, [folder, url]);
  useEffect(() => {
    setData(null); setError(null);
    if (!url) return;
    void load(false).then((first) => { if (first?.remote) void load(true); });
  }, [load, url]);
  return { data, loading, error, reload: () => load(true) };
}

function trackLabel(branch: RemoteBranch) {
  if (!branch.local) return <span className="branch-track muted">só remota</span>;
  if (!branch.ahead && !branch.behind) return <span className="branch-track ok">em dia</span>;
  return <span className="branch-track warn" title={`${branch.ahead} commit(s) local(is) para enviar, ${branch.behind} para baixar`}>{branch.ahead ? `↑${branch.ahead}` : ''}{branch.ahead && branch.behind ? ' ' : ''}{branch.behind ? `↓${branch.behind}` : ''}</span>;
}

export function BranchesPanel({ repo, remote, onOpenPr }: { repo: RepoInfo; remote: ReturnType<typeof useRemoteBranches>; onOpenPr: (head: string) => void }) {
  const [filter, setFilter] = useState('');
  const { data, loading, error } = remote;
  const query = filter.trim().toLowerCase();
  const branches = (data?.branches ?? []).filter((branch) => !query || branch.name.toLowerCase().includes(query) || branch.author?.toLowerCase().includes(query));
  const source = data ? data.remote ? `Remoto local “${data.remote}” · sincroniza com git fetch` : 'Lido direto do servidor: esta pasta não tem um remoto apontando para o repositório.' : '';
  return <section className="git-panel">
    <div className="git-panel-head"><h2>Branches remotas {data && <small>· {data.branches.length}</small>}</h2>
      <div className="git-panel-actions"><label className="git-filter"><Search size={13} /><input aria-label="Filtrar branches" placeholder="Filtrar" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
        <button type="button" className="button-quiet button-sm" disabled={loading} onClick={() => void remote.reload()}><RefreshCw size={13} className={loading ? 'spin' : ''} /> Sincronizar</button></div></div>
    {source && <p className="git-panel-note">{source}</p>}
    {error && <p className="tools-error" role="alert">{error}</p>}
    {data?.fetchError && <p className="tools-error" role="alert">Não foi possível buscar do remoto; mostrando o último estado conhecido. {data.fetchError}</p>}
    {!data && loading && <p>Carregando branches…</p>}
    {data && !branches.length && <p>{query ? 'Nenhuma branch encontrada.' : 'Nenhuma branch remota.'}</p>}
    <div className="remote-branches">{branches.map((branch) => <div className="remote-branch" key={branch.name}>
      <div className="remote-branch-main">
        <div className="remote-branch-name"><code>{branch.name}</code>{branch.name === data?.defaultBranch && <span className="git-badge">padrão</span>}{branch.current && <span className="git-badge accent">atual</span>}</div>
        <small>{[branch.sha, branch.subject, branch.author, timeAgo(branch.date)].filter(Boolean).join(' · ')}</small>
      </div>
      {trackLabel(branch)}
      {branch.name !== data?.defaultBranch && <button type="button" className="button-quiet button-sm" onClick={() => onOpenPr(branch.name)}><GitPullRequest size={13} /> Abrir PR</button>}
    </div>)}</div>
    {repo.provider === 'other' ? null : <button type="button" className="button-ghost button-sm git-site-link" onClick={() => void openUrl(`${repo.webUrl}${repo.provider === 'gitlab' ? '/-/branches' : '/branches'}`)}><ExternalLink size={13} /> Ver branches no {providerName(repo.provider)}</button>}
  </section>;
}

export function PullRequestsPanel({ repo, url, folder, remote, localBranches, currentBranch, head: requestedHead, onCount }: {
  repo: RepoInfo; url: string; folder: string | null; remote: ReturnType<typeof useRemoteBranches>;
  localBranches: string[]; currentBranch: string; head: string | null; onCount: (count: number | null) => void;
}) {
  const [pulls, setPulls] = useState<PullRequests | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [head, setHead] = useState(requestedHead ?? currentBranch);
  const [base, setBase] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const [push, setPush] = useState(true);
  const [busy, setBusy] = useState(false);
  const github = repo.provider === 'github';

  const load = useCallback(async () => {
    if (!github) return;
    setLoading(true);
    try { const result = await invoke<PullRequests>('git_pull_requests', { url }); setPulls(result); setError(null); onCount(result.items.length); }
    catch (reason) { setError(String(reason)); onCount(null); }
    finally { setLoading(false); }
  }, [github, url, onCount]);
  useEffect(() => { setPulls(null); void load(); }, [load]);
  useEffect(() => { if (requestedHead) setHead(requestedHead); }, [requestedHead]);

  const remoteNames = useMemo(() => (remote.data?.branches ?? []).map((branch) => branch.name), [remote.data]);
  const defaultBase = pulls?.defaultBranch ?? remote.data?.defaultBranch ?? (remoteNames.includes('main') ? 'main' : remoteNames.includes('master') ? 'master' : remoteNames[0] ?? '');
  const baseValue = base || defaultBase;
  const headOptions = [...new Set([...localBranches, ...remoteNames])].sort((a, b) => a.localeCompare(b));
  const canPush = Boolean(folder && remote.data?.remote && localBranches.includes(head));

  if (!github) return <section className="git-panel">
    <div className="git-panel-head"><h2>Pull requests</h2></div>
    <p>Listar e abrir pull requests dentro do app funciona com repositórios do GitHub (pelo GitHub CLI). Para {providerName(repo.provider)}, use o site:</p>
    <div className="git-panel-actions">
      <button type="button" className="button-quiet button-sm" disabled={!repo.pullsUrl} onClick={() => void openUrl(repo.pullsUrl)}><ExternalLink size={13} /> Ver PRs abertos</button>
      <button type="button" className="button-quiet button-sm" disabled={!repo.newPullUrl} onClick={() => void openUrl(repo.newPullUrl)}><GitPullRequest size={13} /> Novo PR no site</button>
    </div>
  </section>;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setCreated(null);
    try {
      if (push && canPush) { await invoke('git_push_branch', { folder, url, branch: head }); void remote.reload(); }
      const link = await invoke<string>('git_create_pull_request', { url, base: baseValue, head, title, body, draft });
      setCreated(link); setTitle(''); setBody(''); setDraft(false); setError(null);
      await load();
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };

  return <div className="git-pr-layout">
    <section className="git-panel">
      <div className="git-panel-head"><h2>PRs em aberto {pulls && <small>· {pulls.items.length}</small>}</h2>
        <div className="git-panel-actions"><button type="button" className="button-quiet button-sm" disabled={loading} onClick={() => void load()}><RefreshCw size={13} className={loading ? 'spin' : ''} /> Atualizar</button>
          <button type="button" className="button-ghost button-sm" onClick={() => void openUrl(repo.pullsUrl)}><ExternalLink size={13} /> No GitHub</button></div></div>
      {error && <p className="tools-error" role="alert">{error}</p>}
      {!pulls && loading && <p>Carregando pull requests…</p>}
      {pulls && !pulls.items.length && <p>Nenhum pull request aberto.</p>}
      <div className="pull-list">{pulls?.items.map((pull) => <button type="button" className="pull-row" key={pull.number} onClick={() => void openUrl(pull.url)} title="Abrir no GitHub">
        <span className="pull-number">#{pull.number}</span>
        <span className="pull-main"><strong>{pull.title}</strong>
          <small><code>{pull.headRefName}</code> → <code>{pull.baseRefName}</code>{pull.author ? ` · ${pull.author}` : ''}{pull.createdAt ? ` · ${timeAgo(pull.createdAt)}` : ''}</small></span>
        <span className="pull-tags">{pull.isDraft && <span className="git-badge">rascunho</span>}{pull.reviewDecision && REVIEW[pull.reviewDecision] && <span className={`git-badge ${pull.reviewDecision === 'APPROVED' ? 'ok' : pull.reviewDecision === 'CHANGES_REQUESTED' ? 'warn' : ''}`}>{REVIEW[pull.reviewDecision]}</span>}</span>
      </button>)}</div>
    </section>
    <form className="git-panel git-pr-form" onSubmit={submit}>
      <div className="git-panel-head"><h2>Abrir pull request</h2></div>
      <div className="git-pr-branches">
        <div className="form-field"><span>De (origem)</span><Select label="Branch de origem" value={head} onChange={setHead} placeholder="Escolha a branch" options={headOptions} /></div>
        <span className="git-pr-arrow">→</span>
        <div className="form-field"><span>Para (destino)</span><Select label="Branch de destino" value={baseValue} onChange={setBase} placeholder="Escolha a branch" options={remoteNames.length ? remoteNames : baseValue ? [baseValue] : []} /></div>
      </div>
      <label className="form-field"><span>Título</span><input value={title} maxLength={256} onChange={(event) => setTitle(event.target.value)} placeholder="Resumo da mudança" required /></label>
      <label className="form-field"><span>Descrição</span><textarea value={body} maxLength={20000} onChange={(event) => setBody(event.target.value)} placeholder="O que muda e como testar (opcional)" rows={5} /></label>
      <label className="git-check"><input type="checkbox" checked={draft} onChange={(event) => setDraft(event.target.checked)} /> Abrir como rascunho</label>
      {canPush && <label className="git-check"><input type="checkbox" checked={push} onChange={(event) => setPush(event.target.checked)} /> Enviar <code>{head}</code> para “{remote.data?.remote}” antes (git push -u)</label>}
      {created && <p className="tools-success" role="status">Pull request criado. <button type="button" className="link-button" onClick={() => void openUrl(created)}>Abrir no GitHub</button></p>}
      <button className="button-primary" disabled={busy || !head || !baseValue || !title.trim() || head === baseValue}><GitPullRequest size={14} /> {busy ? 'Abrindo…' : 'Abrir pull request'}</button>
    </form>
  </div>;
}
