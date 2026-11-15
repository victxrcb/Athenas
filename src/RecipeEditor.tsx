import { useState } from 'react';
import { BookOpen, Play, Plus, Trash2, X } from 'lucide-react';
import { AgentIcon } from './AgentIcon';
import { Select } from './Select';
import { recipeFromSessions, runRecipe, saveRecipe, type Recipe, type RecipeItem } from './recipes';
import { useAppStore, type Agent, type Mode, type ProjectInfo } from './store';

const AGENTS: Agent[] = ['Claude Code', 'Codex', 'Shell'];
const MODES: Mode[] = ['Normal', 'Plan', 'Auto-aceitar'];

/** Edits the project's recipe: which sessions open together, with an optional first prompt or shell command. */
export function RecipeEditor({ project, onClose }: { project: ProjectInfo; onClose: () => void }) {
  const { sessions, setNotice } = useAppStore();
  const [items, setItems] = useState<RecipeItem[]>(project.recipe?.items ?? [{ agent: 'Claude Code', mode: 'Normal', startup: null }]);
  const [autostart, setAutostart] = useState(project.recipe?.autostart ?? false);
  const [busy, setBusy] = useState(false);
  const fromOpen = recipeFromSessions(sessions, project);
  const update = (index: number, patch: Partial<RecipeItem>) => setItems((current) => current.map((item, at) => (at === index ? { ...item, ...patch, ...(patch.agent === 'Shell' ? { mode: 'Normal' as Mode } : {}) } : item)));

  const save = async (run: boolean) => {
    const recipe: Recipe = { autostart, items: items.map((item) => ({ ...item, startup: item.startup?.trim() || null })) };
    setBusy(true);
    try {
      await saveRecipe(project, recipe);
      if (run) setNotice(`${await runRecipe(project, recipe)} sessão(ões) aberta(s) pela receita.`);
      else setNotice('Receita salva.');
      onClose();
    } catch (error) { setNotice(String(error)); }
    finally { setBusy(false); }
  };

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
    <div className="modal recipe-modal" role="dialog" aria-modal="true" aria-label="Receita do projeto">
      <div className="modal-top"><span className="section-kicker"><BookOpen size={13} /> Receita · {project.name}</span><button type="button" className="icon-button" aria-label="Fechar" onClick={onClose}><X size={16} /></button></div>
      <h2>Abra tudo de uma vez.</h2>
      <p className="modal-intro">Cada linha vira um painel. No Shell, o comando é digitado assim que ele abre (ex.: <code>npm run dev</code>); nos agentes, o texto é o primeiro prompt.</p>
      <div className="recipe-items">
        {items.map((item, index) => <div className="recipe-item" key={index}>
          <Select label="Agente" value={item.agent} onChange={(value) => update(index, { agent: value as Agent })} options={AGENTS.map((agent) => ({ value: agent, label: agent, icon: <AgentIcon agent={agent} size={13} /> }))} />
          <Select label="Modo" value={item.mode} disabled={item.agent === 'Shell'} onChange={(value) => update(index, { mode: value as Mode })} options={MODES} />
          <input value={item.startup ?? ''} onChange={(event) => update(index, { startup: event.target.value })} aria-label={item.agent === 'Shell' ? 'Comando ao abrir' : 'Primeiro prompt'}
            placeholder={item.agent === 'Shell' ? 'Comando ao abrir (opcional)' : 'Primeiro prompt (opcional)'} />
          <button type="button" className="icon-button small" aria-label="Remover linha" disabled={items.length === 1} onClick={() => setItems((current) => current.filter((_, at) => at !== index))}><Trash2 size={14} /></button>
        </div>)}
      </div>
      <div className="recipe-tools">
        <button type="button" className="button-quiet button-sm" disabled={items.length >= 8} onClick={() => setItems((current) => [...current, { agent: 'Shell', mode: 'Normal', startup: null }])}><Plus size={13} /> Adicionar sessão</button>
        <button type="button" className="button-quiet button-sm" disabled={!fromOpen.length} title={fromOpen.length ? 'Substitui as linhas pelas sessões abertas neste projeto' : 'Nenhuma sessão aberta neste projeto'} onClick={() => setItems(fromOpen)}>{fromOpen.length === 1 ? 'Usar a sessão aberta' : `Usar as ${fromOpen.length || ''} sessões abertas`.replace('  ', ' ')}</button>
      </div>
      <label className="settings-check recipe-autostart"><input type="checkbox" checked={autostart} onChange={(event) => setAutostart(event.target.checked)} /> Abrir automaticamente quando eu entrar no projeto sem nenhuma sessão rodando</label>
      <div className="modal-footer">
        {project.recipe ? <button type="button" className="button-quiet danger-text" disabled={busy} onClick={() => { void saveRecipe(project, null).then(() => { setNotice('Receita removida.'); onClose(); }).catch((error) => setNotice(String(error))); }}>Remover receita</button> : <span />}
        <div><button type="button" className="button-quiet" disabled={busy} onClick={() => void save(false)}>Salvar</button><button type="button" className="button-primary" disabled={busy} onClick={() => void save(true)}><Play size={13} /> Salvar e abrir</button></div>
      </div>
    </div>
  </div>;
}
