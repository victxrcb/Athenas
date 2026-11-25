import { memo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { MessageCircleQuestion, ShieldAlert, TerminalSquare } from 'lucide-react';
import { notice } from './actions';
import { readQuestions } from './claudeAdapter';
import { shortPath } from './DiffViewer';
import { Markdown } from './Markdown';
import type { Question } from './model';
import type { PermissionRequest } from './store';
import type { ChatScope } from './Tools';

type Decision = { behavior: 'allow' | 'deny' | 'always' | 'answer'; suggestion?: number; answers?: Record<string, string> };

const SCOPES: Record<string, string> = {
  session: 'nesta sessão', localSettings: 'neste projeto (configuração local)', projectSettings: 'neste projeto (compartilhado)', userSettings: 'em todos os projetos',
};

/** Exactly what a suggestion from Claude Code would allow, so "always" is never a blank check. */
export function suggestionLabel(suggestion: any): string | null {
  const scope = SCOPES[suggestion?.destination] ?? String(suggestion?.destination ?? '');
  if (suggestion?.type === 'addRules' && suggestion.behavior === 'allow' && Array.isArray(suggestion.rules)) {
    const rules = suggestion.rules.map((rule: any) => (rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName)).join(', ');
    return `Sempre permitir ${rules} ${scope}`;
  }
  if (suggestion?.type === 'addDirectories' && Array.isArray(suggestion.directories)) return `Liberar a pasta ${suggestion.directories.join(', ')} ${scope}`;
  if (suggestion?.type === 'setMode' && suggestion.mode === 'acceptEdits') return `Aceitar edições automaticamente ${scope}`;
  return null;
}

function useDecision(request: PermissionRequest) {
  const [busy, setBusy] = useState(false);
  const decide = (decision: Decision) => {
    setBusy(true);
    void invoke('chat_permission_decide', { sessionId: request.sessionId, requestId: request.id, decision })
      .catch((error) => { notice(String(error)); setBusy(false); });
  };
  return { busy, decide };
}

function Subject({ request, scope }: { request: PermissionRequest; scope: ChatScope }) {
  const input = request.toolInput ?? {};
  if (typeof input.command === 'string') return <><p>O agente quer executar um comando{input.description ? `: ${input.description}` : '.'}</p><pre>{input.command}</pre></>;
  const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null;
  if (path) {
    const removed: string | null = typeof input.old_string === 'string' ? input.old_string : null;
    const added: string | null = typeof input.new_string === 'string' ? input.new_string : typeof input.content === 'string' ? input.content : null;
    return <><p>O agente quer usar <strong>{request.toolName}</strong> em <code title={path}>{shortPath(path, scope.cwd)}</code></p>
      {(removed || added) && <pre className="chat-preview">{removed && <span className="remove">{removed.split('\n').map((line) => `- ${line}`).join('\n')}{'\n'}</span>}{added && <span className="add">{added.split('\n').map((line) => `+ ${line}`).join('\n')}</span>}</pre>}</>;
  }
  return <><p>O agente quer usar <strong>{request.toolName}</strong>.</p><pre>{JSON.stringify(input, null, 2)}</pre></>;
}

function Permission({ request, scope }: { request: PermissionRequest; scope: ChatScope }) {
  const { busy, decide } = useDecision(request);
  const options = request.suggestions.map((suggestion, index) => ({ index, label: suggestionLabel(suggestion) })).filter((item) => item.label);
  return <section className="chat-request" role="alertdialog" aria-label="Autorização necessária">
    <header><ShieldAlert size={15} /><strong>Autorização necessária</strong>{request.agentId && <small>pedido por um subagente</small>}</header>
    <Subject request={request} scope={scope} />
    {scope.cwd && <p className="chat-muted">Diretório: <code>{scope.cwd}</code></p>}
    <footer>
      <button type="button" className="button-quiet button-sm" disabled={busy} onClick={() => decide({ behavior: 'deny' })}>Recusar</button>
      <button type="button" className="chat-primary" disabled={busy} onClick={() => decide({ behavior: 'allow' })}>Permitir uma vez</button>
      {options.map(({ index, label }) => <button key={index} type="button" className="button-quiet button-sm chat-always" title={label!} disabled={busy} onClick={() => decide({ behavior: 'always', suggestion: index })}>{label}</button>)}
      <button type="button" className="chat-link-button" onClick={scope.openTerminal}><TerminalSquare size={12} /> Responder no terminal</button>
    </footer>
  </section>;
}

export function QuestionForm({ questions, busy, onAnswer, onRefuse, onTerminal }: {
  questions: Question[]; busy: boolean; onAnswer: (answers: Record<string, string>) => void; onRefuse: () => void; onTerminal: () => void;
}) {
  const [chosen, setChosen] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  // A typed answer replaces a single choice and joins a multiple one.
  const answer = (index: number) => {
    const typed = other[index]?.trim();
    const picked = chosen[index] ?? [];
    return (questions[index].multiSelect ? [...picked, ...(typed ? [typed] : [])] : typed ? [typed] : picked).join(', ');
  };
  const complete = questions.every((_, index) => answer(index));
  return <form onSubmit={(event) => { event.preventDefault(); if (complete) onAnswer(Object.fromEntries(questions.map((question, index) => [question.question, answer(index)]))); }}>
    {questions.map((question, index) => <fieldset key={question.question} disabled={busy}>
      <legend>{question.header && <small>{question.header}</small>}{question.question}</legend>
      {question.options.map((option) => {
        const checked = (chosen[index] ?? []).includes(option.label) && (question.multiSelect || !other[index]?.trim());
        return <label key={option.label} className={checked ? 'selected' : undefined}>
          <input type={question.multiSelect ? 'checkbox' : 'radio'} name={`question-${index}`} checked={checked} onChange={() => {
            setChosen((current) => {
              const list = current[index] ?? [];
              return { ...current, [index]: !question.multiSelect ? [option.label] : list.includes(option.label) ? list.filter((item) => item !== option.label) : [...list, option.label] };
            });
            if (!question.multiSelect) setOther((current) => ({ ...current, [index]: '' }));
          }} />
          <span>{option.label}{option.description && <small>{option.description}</small>}</span>
        </label>;
      })}
      <input type="text" className="chat-other" aria-label={`Outra resposta para: ${question.question}`} placeholder="Outra resposta…" value={other[index] ?? ''} onChange={(event) => setOther((current) => ({ ...current, [index]: event.target.value }))} />
    </fieldset>)}
    <footer>
      <button type="button" className="button-quiet button-sm" disabled={busy} onClick={onRefuse}>Não responder</button>
      <button type="submit" className="chat-primary" disabled={busy || !complete}>Enviar resposta</button>
      <button type="button" className="chat-link-button" onClick={onTerminal}><TerminalSquare size={12} /> Responder no terminal</button>
    </footer>
  </form>;
}

function QuestionRequest({ request, questions, scope }: { request: PermissionRequest; questions: Question[]; scope: ChatScope }) {
  const { busy, decide } = useDecision(request);
  return <section className="chat-request question" role="group" aria-label="Pergunta do agente">
    <header><MessageCircleQuestion size={15} /><strong>O agente precisa de uma decisão</strong></header>
    <QuestionForm questions={questions} busy={busy} onAnswer={(answers) => decide({ behavior: 'answer', answers })} onRefuse={() => decide({ behavior: 'deny' })} onTerminal={scope.openTerminal} />
  </section>;
}

function PlanRequest({ request, scope }: { request: PermissionRequest; scope: ChatScope }) {
  const { busy, decide } = useDecision(request);
  return <section className="chat-request" role="group" aria-label="Plano para aprovação">
    <header><ShieldAlert size={15} /><strong>Plano aguardando aprovação</strong></header>
    {typeof request.toolInput?.plan === 'string' && <div className="chat-plan"><Markdown text={request.toolInput.plan} sessionId={scope.sessionId} /></div>}
    <p className="chat-muted">A aprovação de um plano define o modo de execução, por isso é feita no terminal.</p>
    <footer>
      <button type="button" className="button-quiet button-sm" disabled={busy} onClick={() => decide({ behavior: 'deny' })}>Continuar planejando</button>
      <button type="button" className="chat-primary" onClick={scope.openTerminal}><TerminalSquare size={13} /> Aprovar no terminal</button>
    </footer>
  </section>;
}

export const RequestCard = memo(function RequestCard({ request, scope }: { request: PermissionRequest; scope: ChatScope }) {
  const questions = request.toolName === 'AskUserQuestion' ? readQuestions(request.toolInput) : undefined;
  if (questions?.length) return <QuestionRequest request={request} questions={questions} scope={scope} />;
  if (request.toolName === 'ExitPlanMode') return <PlanRequest request={request} scope={scope} />;
  return <Permission request={request} scope={scope} />;
});

/** The agent reported it is waiting but offers no structured way to answer from here. */
export function TerminalAttention({ message, scope }: { message: string; scope: ChatScope }) {
  return <section className="chat-request" role="status">
    <header><ShieldAlert size={15} /><strong>Aguardando sua resposta</strong></header>
    {message && <p>{message}</p>}
    <footer><button type="button" className="chat-primary" onClick={scope.openTerminal}><TerminalSquare size={13} /> Responder no terminal</button></footer>
  </section>;
}
