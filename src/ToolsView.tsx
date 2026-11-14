import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { ExternalLink, FolderOpen, GitBranch, GitCommitHorizontal, GitPullRequest, RefreshCw, Save } from 'lucide-react';
import { BranchesPanel, PullRequestsPanel, openUrl, providerName, useRemoteBranches, type RepoInfo } from './GitRemote';
import { useAppStore } from './store';

type GitSnapshot = { branch: string; status: string; branches: string[]; worktrees: string };
type McpConfig = { id: string; agent: string; path: string; text: string; servers: string[] };
type Skill = { name: string; description: string; path: string; agent: string };

type GitTab = 'changes' | 'branches' | 'pulls';

function GitView({ folder, repoUrl }: { folder: string | null; repoUrl: string | null }) {
  const [tab, setTab] = useState<GitTab>('changes');
  const [prHead, setPrHead] = useState<string | null>(null);
  const [prCount, setPrCount] = useState<number | null>(null);
  const [origin, setOrigin] = useState<string | null>(null);
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const url = repoUrl || origin;
  useEffect(() => {
    setOrigin(null);
    if (!folder || repoUrl || !isTauri()) return;
    let alive = true;
    void invoke<string | null>('git_origin_url', { folder }).then((value) => { if (alive) setOrigin(value); }).catch(() => undefined);
    return () => { alive = false; };
  }, [folder, repoUrl]);
  useEffect(() => {
    setRepo(null); setRepoError(null); setPrCount(null); setPrHead(null);
    if (!url || !isTauri()) return;
    let alive = true;
    void invoke<RepoInfo>('git_repo_info', { url }).then((info) => { if (alive) setRepo(info); }).catch((reason) => { if (alive) setRepoError(String(reason)); });
    return () => { alive = false; };
  }, [url]);
  const remote = useRemoteBranches(folder, repo ? url : null);
  const [data, setData] = useState<GitSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  const [message, setMessage] = useState('');
  const [branch, setBranch] = useState('');
  const refresh = async () => {
    if (!folder || !isTauri()) return;
    try { setData(await invoke<GitSnapshot>('git_snapshot', { folder })); setError(null); }
    catch (reason) { setError(String(reason)); }
  };
  useEffect(() => { void refresh(); }, [folder]);
  if (!folder) return <div className="tools-empty">Escolha um projeto com pasta para usar Git.</div>;
  if (!isTauri()) return <div className="tools-empty">Abra o aplicativo desktop para usar Git.</div>;
  const files = data?.status.split('\n').filter(Boolean).map((line) => ({ code: line.slice(0, 2), path: line.slice(3) })) ?? [];
  const action = async (task: () => Promise<unknown>) => { try { await task(); await refresh(); setError(null); } catch (reason) { setError(String(reason)); } };
  const diffRows = diff.split('\n').map((line) => ({ left: line.startsWith('+') && !line.startsWith('+++') ? '' : line, right: line.startsWith('-') && !line.startsWith('---') ? '' : line }));
  const repoLine = repo
    ? <p className="git-repo-line">{providerName(repo.provider)} · <button type="button" className="link-button" onClick={() => void openUrl(repo.webUrl).catch((reason) => setError(String(reason)))}>{repo.slug} <ExternalLink size={11} /></button>{!repoUrl && <small> · usando o origin da pasta</small>}</p>
    : repoError ? <p className="git-repo-line">Link do repositório inválido: {repoError}</p>
    : <p className="git-repo-line">Sem repositório remoto. Adicione o link em <em>Editar projeto</em>.</p>;
  const remoteNeeded = <div className="tools-empty inline">Adicione o link do repositório em <em>Editar projeto</em> (ou um remoto <code>origin</code> na pasta) para acompanhar branches e pull requests.</div>;
  return <div className="tools-content"><div className="tools-heading"><div><span className="section-kicker">Controle de versão</span><h1>Git</h1><p>{folder}</p>{repoLine}</div><button onClick={() => { void refresh(); if (tab === 'branches') void remote.reload(); }}><RefreshCw size={15} /> Atualizar</button></div>
    {error && <p className="tools-error" role="alert">{error}</p>}
    <div className="segmented git-tabs" role="tablist" aria-label="Seções do Git">
      <button type="button" role="tab" aria-selected={tab === 'changes'} className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}><GitCommitHorizontal size={13} /> Alterações {files.length > 0 && <small>{files.length}</small>}</button>
      <button type="button" role="tab" aria-selected={tab === 'branches'} className={tab === 'branches' ? 'active' : ''} onClick={() => setTab('branches')}><GitBranch size={13} /> Branches {remote.data && <small>{remote.data.branches.length}</small>}</button>
      <button type="button" role="tab" aria-selected={tab === 'pulls'} className={tab === 'pulls' ? 'active' : ''} onClick={() => setTab('pulls')}><GitPullRequest size={13} /> Pull requests {prCount !== null && <small>{prCount}</small>}</button>
    </div>
    {tab === 'branches' && (repo && url ? <BranchesPanel repo={repo} remote={remote} onOpenPr={(head) => { setPrHead(head); setTab('pulls'); }} /> : remoteNeeded)}
    {tab === 'pulls' && (repo && url ? <PullRequestsPanel repo={repo} url={url} folder={folder} remote={remote} localBranches={data?.branches ?? []} currentBranch={data?.branch ?? ''} head={prHead} onCount={setPrCount} /> : remoteNeeded)}
    {tab === 'changes' && <>{data && <><div className="git-meta"><GitBranch size={15} /> {data.branch || 'HEAD destacado'} <span>· {files.length} arquivo(s) alterado(s)</span></div><div className="tools-columns"><section><h2>Arquivos</h2>{files.length ? files.map((item) => <div className="git-file" key={item.path}><button onClick={async () => { setFile(item.path); try { setDiff(await invoke<string>('git_file_diff', { folder, file: item.path, staged: item.code[0] !== ' ' })); } catch (reason) { setError(String(reason)); } }}><code>{item.code}</code>{item.path}</button><button aria-label={`${item.code[0] === ' ' || item.code === '??' ? 'Stage' : 'Unstage'} ${item.path}`} onClick={() => void action(() => invoke('git_stage', { folder, file: item.path, stage: item.code[0] === ' ' || item.code === '??' }))}>{item.code[0] === ' ' || item.code === '??' ? '+' : '−'}</button></div>) : <p>Nenhuma alteração.</p>}<div className="git-commit"><input aria-label="Mensagem de commit" placeholder="Mensagem do commit" value={message} onChange={(event) => setMessage(event.target.value)} /><button onClick={() => void action(async () => { await invoke('git_commit', { folder, message }); setMessage(''); })}>Commit</button></div></section><section><h2>Diff {file && <small>· {file}</small>}</h2>{file ? <div className="diff-view">{diffRows.map((row, index) => <div className="diff-row" key={index}><code className={row.left.startsWith('-') ? 'removed' : ''}>{row.left}</code><code className={row.right.startsWith('+') ? 'added' : ''}>{row.right}</code></div>)}</div> : <p>Selecione um arquivo.</p>}</section></div><div className="tools-columns lower"><section><h2>Branches</h2>{data.branches.map((name) => <div className="git-list-row" key={name}>{name}</div>)}</section><section><h2>Worktrees</h2><pre>{data.worktrees || 'Nenhum worktree.'}</pre><div className="git-commit"><input aria-label="Nova branch de worktree" placeholder="Nome da nova branch" value={branch} onChange={(event) => setBranch(event.target.value)} /><button onClick={() => void action(async () => { await invoke('git_create_worktree', { folder, branch }); setBranch(''); })}>Criar worktree</button></div></section></div></>}</>}</div>;
}

function McpView({ folder }: { folder: string | null }) {
  const [configs, setConfigs] = useState<McpConfig[]>([]);
  const [selectedId, setSelectedId] = useState('claude_user');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    void invoke<McpConfig[]>('mcp_config_list', { projectFolder: folder }).then((items) => { setConfigs(items); setError(null); }).catch((reason) => setError(String(reason)));
  }, [folder]);
  useEffect(() => { setText(configs.find((item) => item.id === selectedId)?.text ?? ''); }, [configs, selectedId]);
  const selected = configs.find((item) => item.id === selectedId);
  if (!isTauri()) return <div className="tools-empty">Abra o aplicativo desktop para editar MCP.</div>;
  return <div className="tools-content"><div className="tools-heading"><div><span className="section-kicker">Servidores locais</span><h1>MCP</h1><p>Uma cópia de backup é criada antes de cada gravação.</p></div></div>{error && <p className="tools-error" role="alert">{error}</p>}{notice && <p className="tools-success" role="status">{notice}</p>}<div className="tools-columns mcp-columns"><section><h2>Configurações</h2>{configs.map((item) => <button className={`mcp-source ${selectedId === item.id ? 'selected' : ''}`} key={item.id} onClick={() => { setSelectedId(item.id); setNotice(null); }}>{item.agent}<small>{item.path}</small></button>)}<h2>Servidores</h2>{selected?.servers.length ? selected.servers.map((server) => <div className="git-list-row" key={server}>{server} <small>· {selected.agent}</small></div>) : <p>Nenhum servidor neste arquivo.</p>}</section><section><h2>Editar {selected?.agent ?? ''}</h2><textarea aria-label="Configuração MCP" spellCheck={false} value={text} onChange={(event) => setText(event.target.value)} /><button className="button-primary" disabled={!selected} onClick={async () => { try { const saved = await invoke<McpConfig>('mcp_config_write', { id: selectedId, projectFolder: folder, text }); setConfigs((current) => current.map((item) => item.id === selectedId ? saved : item)); setNotice('Configuração salva com backup.'); setError(null); } catch (reason) { setError(String(reason)); } }}><Save size={14} /> Salvar configuração</button></section></div></div>;
}

function SkillsView({ folder }: { folder: string | null }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    void invoke<Skill[]>('skills_list', { projectFolder: folder }).then((items) => { setSkills(items); setError(null); }).catch((reason) => setError(String(reason)));
  }, [folder]);
  if (!isTauri()) return <div className="tools-empty">Abra o aplicativo desktop para ver Skills.</div>;
  return <div className="tools-content"><div className="tools-heading"><div><span className="section-kicker">Somente leitura</span><h1>Skills</h1><p>Skills instaladas para Claude Code e Codex.</p></div></div>{error && <p className="tools-error" role="alert">{error}</p>}{skills.length ? <div className="skills-list">{skills.map((skill) => <div className="skill-card" key={`${skill.agent}:${skill.path}`}><div><span>{skill.agent}</span><h2>{skill.name}</h2><p>{skill.description || 'Sem descrição.'}</p><small>{skill.path}</small></div><button aria-label={`Abrir pasta de ${skill.name}`} onClick={() => void invoke('skill_open_folder', { projectFolder: folder, path: skill.path }).catch((reason) => setError(String(reason)))}><FolderOpen size={17} /></button></div>)}</div> : <p>Nenhuma skill encontrada.</p>}</div>;
}

export function ToolsView() {
  const state = useAppStore();
  const project = state.workspace.projects.find((item) => item.id === state.activeProjectId);
  const folder = project?.folder ?? null;
  return state.section === 'git' ? <GitView folder={folder} repoUrl={project?.repoUrl ?? null} /> : state.section === 'mcp' ? <McpView folder={folder} /> : <SkillsView folder={folder} />;
}
