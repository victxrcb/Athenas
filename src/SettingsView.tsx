import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { X } from 'lucide-react';
import { useAppStore, type Preferences } from './store';
import { DEFAULT_THEME, THEMES, applyTheme, loadTheme, type ThemeId } from './themes';
import { ZOOM_LEVELS, applyZoom, loadZoom, stepZoom } from './zoom';
import { Eye, EyeOff, Minus, Plus } from 'lucide-react';
import { DEFAULT_FONT, FONT_PRESETS, applyFont, fontStack, isValidFontName, loadFont, type FontChoice } from './font';
import { SIDEBAR_ITEMS, setSidebarHidden, setSidebarItem, useSidebarPrefs } from './sidebarPrefs';
import { DEFAULT_MASCOT, MASCOT_COLORS, MASCOT_EYES, MASCOT_OUTFITS, saveMascot, useMascot } from './mascot';
import { MascotIcon } from './MascotIcon';

export function SettingsView() {
  const { settingsOpen, setSettingsOpen, preferences, setPreferences, setNotice } = useAppStore();
  const [draft, setDraft] = useState<Preferences>(preferences);
  const [saving, setSaving] = useState(false);
  const [theme, setTheme] = useState<ThemeId>(loadTheme);
  const [zoom, setZoom] = useState(loadZoom);
  const mascot = useMascot();
  const sidebarPrefs = useSidebarPrefs();
  const [font, setFont] = useState<FontChoice>(loadFont);
  const [customFont, setCustomFont] = useState(() => loadFont().custom);
  // Ctrl +/−/0 can change the zoom while settings are open; keep the control in sync.
  useEffect(() => { const sync = (event: Event) => setZoom((event as CustomEvent<number>).detail); window.addEventListener('athenas-zoom', sync); return () => window.removeEventListener('athenas-zoom', sync); }, []);
  const changeZoom = (level: number) => { setZoom(level); void applyZoom(level).catch((error) => setNotice(`Não foi possível aplicar o zoom: ${error}`)); };
  useEffect(() => { if (settingsOpen) setDraft(preferences); }, [settingsOpen, preferences]);
  if (!settingsOpen) return null;
  const field = (key: 'claudeCommand' | 'codexCommand' | 'shellCommand', label: string) =>
    <label>{label}<input value={draft[key]} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))} /></label>;
  const number = (key: 'workerLimit' | 'scrollbackMb' | 'fontSize', label: string, min: number, max: number) =>
    <label>{label}<input type="number" min={min} max={max} value={draft[key]} onChange={(event) => setDraft((current) => ({ ...current, [key]: Number(event.target.value) }))} /></label>;
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
    <form className="modal settings-modal" role="dialog" aria-modal="true" aria-label="Configurações" onSubmit={async (event) => {
      event.preventDefault();
      if (!isTauri()) { setNotice('Abra o aplicativo desktop para salvar as preferências.'); return; }
      setSaving(true);
      try { setPreferences(await invoke<Preferences>('settings_save', { settings: draft })); setSettingsOpen(false); setNotice('Preferências salvas.'); }
      catch (error) { setNotice(String(error)); }
      finally { setSaving(false); }
    }}>
      <div className="modal-top"><span className="section-kicker">Preferências</span><button type="button" className="icon-button" aria-label="Fechar configurações" onClick={() => setSettingsOpen(false)}><X size={16} /></button></div>
      <h2>Configurações</h2><p className="modal-intro">Comandos usados para novas sessões e limites locais do aplicativo.</p>
      <div className="settings-grid">{field('claudeCommand', 'Comando Claude Code')}{field('codexCommand', 'Comando Codex')}{field('shellCommand', 'Shell padrão')}{number('workerLimit', 'Workers paralelos', 1, 8)}{number('scrollbackMb', 'Scrollback por terminal (MB)', 1, 50)}{number('fontSize', 'Fonte do terminal (px)', 11, 24)}
        <div className="zoom-picker"><span>Zoom da interface</span><div className="zoom-control">
          <button type="button" className="button-quiet button-sm" aria-label="Diminuir zoom" disabled={zoom <= ZOOM_LEVELS[0]} onClick={() => changeZoom(stepZoom(zoom, -1))}><Minus size={13} /></button>
          <div className="zoom-steps" role="radiogroup" aria-label="Nível de zoom">{ZOOM_LEVELS.map((level) => <button type="button" key={level} role="radio" aria-checked={zoom === level} className={zoom === level ? 'active' : ''} onClick={() => changeZoom(level)}>{Math.round(level * 100)}%</button>)}</div>
          <button type="button" className="button-quiet button-sm" aria-label="Aumentar zoom" disabled={zoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1]} onClick={() => changeZoom(stepZoom(zoom, 1))}><Plus size={13} /></button>
        </div><small>Aumenta textos, ícones e o terminal. Atalhos: <kbd>Ctrl +</kbd> <kbd>Ctrl −</kbd> <kbd>Ctrl 0</kbd></small></div>
        <div className="theme-picker"><span>Tema de cores</span><div className="theme-options">{THEMES.map((item) => <button type="button" key={item.id} className="theme-option" aria-pressed={theme === item.id} onClick={() => { setTheme(item.id); applyTheme(item.id); }}><span className="theme-swatch">{item.swatch.map((color) => <i key={color} style={{ background: color }} />)}</span>{item.name}{item.id === DEFAULT_THEME && <small>Padrão</small>}</button>)}</div></div>
        <div className="mascot-picker"><span>Mascote do Claude</span>
          <div className="mascot-editor">
            <div className="mascot-preview"><MascotIcon config={mascot} size={56} /></div>
            <div className="mascot-controls">
              <div className="mascot-row"><small>Cor</small>
                {MASCOT_COLORS.map((color) => <button type="button" key={color} className="mascot-swatch" aria-label={`Cor ${color}`} aria-pressed={mascot.color === color} style={{ background: color }} onClick={() => saveMascot({ ...mascot, color })} />)}
                <input type="color" className="mascot-color-input" aria-label="Cor personalizada" value={mascot.color} onChange={(event) => saveMascot({ ...mascot, color: event.target.value })} />
              </div>
              <div className="mascot-row"><small>Olhos</small>
                {MASCOT_EYES.map((item) => <button type="button" key={item.id} className="button-quiet button-sm mascot-chip" aria-pressed={mascot.eyes === item.id} onClick={() => saveMascot({ ...mascot, eyes: item.id })}>{item.label}</button>)}
              </div>
              <div className="mascot-row"><small>Estilo</small>
                {MASCOT_OUTFITS.map((item) => <button type="button" key={item.id} className="button-quiet button-sm mascot-chip mascot-outfit" aria-pressed={mascot.outfit === item.id} onClick={() => saveMascot({ ...mascot, outfit: item.id })}><MascotIcon config={{ ...mascot, outfit: item.id }} size={14} className="mascot-outfit-icon" />{item.label}</button>)}
              </div>
              <div className="mascot-row"><small>Extras</small>
                <button type="button" className="button-quiet button-sm mascot-chip" aria-pressed={mascot.antennas} onClick={() => saveMascot({ ...mascot, antennas: !mascot.antennas })}>Antenas</button>
                <button type="button" className="button-quiet button-sm mascot-chip" aria-pressed={mascot.blush} onClick={() => saveMascot({ ...mascot, blush: !mascot.blush })}>Bochechas</button>
                <button type="button" className="button-quiet button-sm" onClick={() => saveMascot(DEFAULT_MASCOT)}>Restaurar</button>
              </div>
            </div>
          </div>
        </div>
        <div className="font-picker"><span>Fonte da interface</span>
          <div className="font-options" role="radiogroup" aria-label="Fonte da interface">
            {FONT_PRESETS.map((item) => <button type="button" key={item.id} role="radio" aria-checked={font.id === item.id} className="font-option" style={{ fontFamily: item.stack }} onClick={() => setFont(applyFont({ id: item.id, custom: font.custom }))}>
              <b>Aa</b><span>{item.name}</span>{item.id === DEFAULT_FONT && <small>Padrão</small>}
            </button>)}
          </div>
          <label className="font-custom">
            <input aria-label="Fonte instalada personalizada" placeholder="Outra fonte instalada (ex.: Roboto, Fira Sans)" value={customFont} aria-invalid={customFont.trim() !== '' && !isValidFontName(customFont)}
              onChange={(event) => { const value = event.target.value; setCustomFont(value); if (isValidFontName(value)) setFont(applyFont({ id: 'custom', custom: value })); else if (!value.trim() && font.id === 'custom') setFont(applyFont({ id: DEFAULT_FONT, custom: '' })); }} />
            {font.id === 'custom' && <small style={{ fontFamily: fontStack(font) }}>Usando “{font.custom}”. Se não estiver instalada, a Inter é usada.</small>}
          </label>
        </div>
        <div className="sidebar-picker"><span>Barra lateral</span>
          <div className="sidebar-picker-box">
            <div className="sidebar-picker-items" role="group" aria-label="Itens visíveis na barra lateral">
              {SIDEBAR_ITEMS.map((item) => <button type="button" key={item.id} className="button-quiet button-sm mascot-chip" aria-pressed={sidebarPrefs.items[item.id]} onClick={() => setSidebarItem(item.id, !sidebarPrefs.items[item.id])}>{sidebarPrefs.items[item.id] ? <Eye size={12} /> : <EyeOff size={12} />}{item.label}</button>)}
            </div>
            <label className="settings-check"><input type="checkbox" checked={sidebarPrefs.hidden} onChange={(event) => setSidebarHidden(event.target.checked)} /> Ocultar barra lateral</label>
            <small>Escolha os atalhos exibidos na navegação. Atalho para ocultar/mostrar: <kbd>Ctrl B</kbd></small>
          </div>
        </div>
        <label className="settings-check"><input type="checkbox" checked={draft.reducedEffects} onChange={(event) => setDraft((current) => ({ ...current, reducedEffects: event.target.checked }))} /> Fundo ASCII na tela inicial</label></div>
      <div className="modal-footer"><span /><div><button type="button" className="button-quiet" onClick={() => setSettingsOpen(false)}>Cancelar</button><button className="button-primary" disabled={saving}>Salvar</button></div></div>
    </form>
  </div>;
}
