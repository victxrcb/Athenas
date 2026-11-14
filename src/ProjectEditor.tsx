import { useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { ImagePlus, Trash2, X } from 'lucide-react';
import { RepoField } from './RepoField';
import { Select } from './Select';
import { displayPath } from './path';
import { ProjectIcon, imageToIcon } from './ProjectIcon';
import { useAppStore, type ProjectInfo, type WorkspaceSnapshot } from './store';

export function ProjectEditor({ project, onClose }: { project: ProjectInfo; onClose: () => void }) {
  const { workspace, setWorkspace, setNotice } = useAppStore();
  const [name, setName] = useState(project.name);
  const [folder, setFolder] = useState(displayPath(project.folder ?? ''));
  const [groupId, setGroupId] = useState(project.groupId ?? '');
  const [repoUrl, setRepoUrl] = useState(project.repoUrl ?? '');
  const [saving, setSaving] = useState(false);
  // undefined = keep the stored icon, null = back to the default folder, string = new image
  const [icon, setIcon] = useState<string | null | undefined>(undefined);
  const shownIcon = icon === undefined ? project.icon : icon;
  const picker = useRef<HTMLInputElement>(null);

  const choose = async () => {
    if (!isTauri()) { setNotice('O seletor de pasta funciona no app desktop.'); return; }
    const result = await open({ directory: true, multiple: false, defaultPath: folder || undefined });
    if (typeof result === 'string') setFolder(result);
  };

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
    <form className="modal small-modal" role="dialog" aria-modal="true" aria-label="Editar projeto" onSubmit={async (event) => {
      event.preventDefault();
      setSaving(true);
      try {
        let next = await invoke<WorkspaceSnapshot>('project_update', { id: project.id, name, folder, groupId: groupId || null, repoUrl: repoUrl.trim() || null });
        if (icon !== undefined) next = await invoke<WorkspaceSnapshot>('project_set_icon', { id: project.id, icon });
        setWorkspace(next);
        onClose();
        setNotice('Projeto atualizado.');
      } catch (error) { setNotice(String(error)); }
      finally { setSaving(false); }
    }}>
      <div className="modal-top"><span className="section-kicker">Projeto</span><button type="button" className="icon-button" aria-label="Fechar" onClick={onClose}><X size={16} /></button></div>
      <h2>Editar projeto</h2>
      <div className="form-field"><span>Ícone</span>
        <div className="icon-editor">
          <div className="icon-preview"><ProjectIcon icon={shownIcon} size={shownIcon ? 56 : 26} /></div>
          <div className="icon-actions">
            <button type="button" onClick={() => picker.current?.click()}><ImagePlus size={14} /> Enviar imagem</button>
            <button type="button" disabled={!shownIcon} onClick={() => setIcon(null)}><Trash2 size={14} /> Usar pasta padrão</button>
            <small>PNG, JPG ou WebP. A imagem é recortada em quadrado.</small>
          </div>
          <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            try { setIcon(await imageToIcon(file)); } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
          }} />
        </div>
      </div>
      <label className="form-field"><span>Nome</span><input autoFocus value={name} maxLength={80} onChange={(event) => setName(event.target.value)} required /></label>
      <div className="form-field"><span>Grupo</span>
        <Select label="Grupo" value={groupId} onChange={setGroupId} options={[{ value: '', label: 'Sem grupo' }, ...workspace.groups.map((group) => ({ value: group.id, label: group.name }))]} />
      </div>
      <label className="form-field"><span>Pasta</span><div className="folder-row"><input value={folder} onChange={(event) => setFolder(event.target.value)} required /><button type="button" className="button-quiet" onClick={() => void choose()}>Escolher pasta</button></div></label>
      <RepoField value={repoUrl} onChange={setRepoUrl} folder={folder} />
      <div className="modal-footer"><span /><div><button type="button" className="button-quiet" onClick={onClose}>Cancelar</button><button className="button-primary" disabled={saving}>Salvar</button></div></div>
    </form>
  </div>;
}
