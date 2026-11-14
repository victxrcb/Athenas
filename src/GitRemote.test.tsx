import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { BranchesPanel, PullRequestsPanel, timeAgo, type RemoteBranches, type RepoInfo } from './GitRemote';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
const mockedInvoke = vi.mocked(invoke);

afterEach(() => { cleanup(); mockedInvoke.mockReset(); });

const github: RepoInfo = { provider: 'github', host: 'github.com', slug: 'acme/demo', name: 'demo', webUrl: 'https://github.com/acme/demo', pullsUrl: 'https://github.com/acme/demo/pulls', newPullUrl: 'https://github.com/acme/demo/compare' };
const branches: RemoteBranches = {
  remote: 'origin', defaultBranch: 'main', fetchError: null, branches: [
    { name: 'main', sha: 'abc1234', date: null, author: 'Ana', subject: 'first', local: 'main', ahead: 0, behind: 0, current: false },
    { name: 'feature/x', sha: 'def5678', date: null, author: 'Bia', subject: 'wip', local: 'feature/x', ahead: 2, behind: 1, current: true },
    { name: 'hotfix', sha: '9999999', date: null, author: null, subject: null, local: null, ahead: 0, behind: 0, current: false },
  ],
};
const remote = (data: RemoteBranches | null) => ({ data, loading: false, error: null, reload: vi.fn().mockResolvedValue(data) });

describe('git remote panels', () => {
  it('formats relative dates in Portuguese', () => {
    const now = Date.parse('2026-11-14T12:00:00Z');
    expect(timeAgo('2026-11-14T10:00:00Z', now)).toBe('há 2 horas');
    expect(timeAgo('2026-11-14T11:59:50Z', now)).toBe('agora');
    expect(timeAgo('não é data', now)).toBe('');
  });

  it('shows remote branches with tracking state and opens a PR from a branch', () => {
    const onOpenPr = vi.fn();
    render(<BranchesPanel repo={github} remote={remote(branches)} onOpenPr={onOpenPr} />);
    expect(screen.getByText('padrão')).toBeTruthy();
    expect(screen.getByText('atual')).toBeTruthy();
    expect(screen.getByText('em dia')).toBeTruthy();
    expect(screen.getByText('↑2 ↓1')).toBeTruthy();
    expect(screen.getByText('só remota')).toBeTruthy();
    // The default branch has no "Abrir PR" button.
    expect(screen.getAllByRole('button', { name: /Abrir PR/ })).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Filtrar branches'), { target: { value: 'hot' } });
    expect(screen.queryByText('feature/x')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Abrir PR/ }));
    expect(onOpenPr).toHaveBeenCalledWith('hotfix');
  });

  it('lists open pull requests and creates one after pushing the branch', async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === 'git_pull_requests') return { defaultBranch: 'main', items: [{ number: 7, title: 'Mascote de praia', url: 'https://github.com/acme/demo/pull/7', headRefName: 'feature/x', baseRefName: 'main', isDraft: true, createdAt: '', author: 'bia', reviewDecision: 'APPROVED' }] };
      if (command === 'git_push_branch') return 'ok';
      if (command === 'git_create_pull_request') return 'https://github.com/acme/demo/pull/8';
      return null;
    });
    const onCount = vi.fn();
    render(<PullRequestsPanel repo={github} url="https://github.com/acme/demo" folder="C:/demo" remote={remote(branches)} localBranches={['main', 'feature/x']} currentBranch="feature/x" head={null} onCount={onCount} />);
    expect(await screen.findByText('Mascote de praia')).toBeTruthy();
    expect(screen.getByText('rascunho')).toBeTruthy();
    expect(screen.getByText('Aprovado')).toBeTruthy();
    expect(onCount).toHaveBeenCalledWith(1);
    fireEvent.change(screen.getByPlaceholderText('Resumo da mudança'), { target: { value: 'Novo estilo' } });
    fireEvent.click(screen.getByRole('button', { name: /Abrir pull request/ }));
    await screen.findByText(/Pull request criado/);
    expect(mockedInvoke).toHaveBeenCalledWith('git_push_branch', { folder: 'C:/demo', url: 'https://github.com/acme/demo', branch: 'feature/x' });
    expect(mockedInvoke).toHaveBeenCalledWith('git_create_pull_request', { url: 'https://github.com/acme/demo', base: 'main', head: 'feature/x', title: 'Novo estilo', body: '', draft: false });
    const order = mockedInvoke.mock.calls.map(([command]) => command);
    expect(order.indexOf('git_push_branch')).toBeLessThan(order.indexOf('git_create_pull_request'));
  });

  it('sends non-GitHub repositories to the provider site', async () => {
    const azure: RepoInfo = { ...github, provider: 'azure', slug: 'org/proj/api', pullsUrl: 'https://dev.azure.com/org/proj/_git/api/pullrequests?_a=active', newPullUrl: 'https://dev.azure.com/org/proj/_git/api/pullrequestcreate' };
    render(<PullRequestsPanel repo={azure} url="https://dev.azure.com/org/proj/_git/api" folder={null} remote={remote(null)} localBranches={[]} currentBranch="" head={null} onCount={vi.fn()} />);
    expect(screen.getByText(/Para Azure DevOps, use o site/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Ver PRs abertos/ }));
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith('git_open_url', { url: azure.pullsUrl }));
    expect(mockedInvoke).not.toHaveBeenCalledWith('git_pull_requests', expect.anything());
  });
});
