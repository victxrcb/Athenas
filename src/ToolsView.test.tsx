import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ToolsView, toolsProject } from './ToolsView';
import { useAppStore, type ProjectInfo } from './store';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
const mockedInvoke = vi.mocked(invoke);

afterEach(() => { cleanup(); mockedInvoke.mockReset(); });

const project = (id: string, folder: string | null, repoUrl: string | null = null): ProjectInfo =>
  ({ id, groupId: null, name: `Projeto ${id}`, folder, layout: 'auto', splitRatio: 0.5, icon: null, repoUrl, updatedAt: 0 });
const projects = [project('a', 'C:\\dev\\a'), project('b', 'C:\\dev\\b', 'https://github.com/acme/b'), project('c', null)];

describe('tools project', () => {
  it('prefers the active project, then the open session, then a project with a repository', () => {
    expect(toolsProject(projects, 'a', null)?.id).toBe('a');
    // Sessions may carry the verbatim prefix and a different drive-letter case.
    expect(toolsProject(projects, null, '\\\\?\\c:\\dev\\a')?.id).toBe('a');
    expect(toolsProject(projects, null, null)?.id).toBe('b');
    expect(toolsProject(projects, 'c', null)?.id).toBe('b');
    expect(toolsProject([project('c', null)], null, null)).toBeUndefined();
  });

  it('opens Git for the project of the session shown in the sidebar and offers to trust a blocked folder', async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === 'git_snapshot') throw 'PASTA_NAO_CONFIAVEL: o Git bloqueou esta pasta';
      if (command === 'git_repo_info') return { provider: 'github', host: 'github.com', slug: 'acme/b', name: 'b', webUrl: 'https://github.com/acme/b', pullsUrl: '', newPullUrl: '' };
      if (command === 'git_remote_branches') return { remote: null, defaultBranch: null, branches: [], fetchError: null };
      return null;
    });
    useAppStore.setState({
      section: 'git', activeProjectId: null, activeSessionId: 's1',
      sessions: [{ id: 's1', agent: 'Claude Code', folder: 'C:\\dev\\b', command: 'claude', resumeId: null, paneId: null, status: 'rodando' }],
      workspace: { groups: [], projects, panes: [] },
    });
    render(<ToolsView />);
    expect(screen.getByText('C:\\dev\\b')).toBeTruthy();
    expect(await screen.findByText('O Git bloqueou esta pasta.')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Projeto' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confiar nesta pasta' }));
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith('git_trust_folder', { folder: 'C:\\dev\\b' }));
  });
});
