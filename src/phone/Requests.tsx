/** What the agent is waiting for, shown whole before anything can be approved. */
import { useEffect, useState } from 'react';
import { readQuestions } from '../chat/claudeAdapter';
import type { Question } from '../chat/model';
import type { Decision, PermissionRequest } from './api';
import { Text } from './Text';

/** A request that just appeared cannot be approved by a tap already on its way to something else. */
const ARM_MS = 800;

type Props = { request: PermissionRequest; busy: boolean; onDecide: (decision: Decision) => void };

function Subject({ request }: { request: PermissionRequest }) {
  const input = request.toolInput ?? {};
  if (typeof input.command === 'string') return <>
    <p>Quer executar um comando{input.description ? `: ${input.description}` : '.'}</p>
    <pre>{input.command}</pre>
  </>;
  const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null;
  const removed: string | null = typeof input.old_string === 'string' ? input.old_string : null;
  const added: string | null = typeof input.new_string === 'string' ? input.new_string : typeof input.content === 'string' ? input.content : null;
  if (path && (removed !== null || added !== null) && !Array.isArray(input.edits)) return <>
    <p>Quer usar <strong>{request.toolName}</strong> em <code>{path}</code></p>
    <pre>
      {removed && <span className="remove">{removed.split('\n').map((line) => `- ${line}`).join('\n')}{'\n'}</span>}
      {added && <span className="add">{added.split('\n').map((line) => `+ ${line}`).join('\n')}</span>}
    </pre>
  </>;
  // Anything else is shown exactly as received.
  return <><p>Quer usar <strong>{request.toolName}</strong>.</p><pre>{JSON.stringify(input, null, 2)}</pre></>;
}

function Permission({ request, busy, onDecide }: Props) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setArmed(true), ARM_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return <section className="phone-request" role="group" aria-label="Autorização necessária">
    <h3>Autorização necessária{request.agentId && <small> · subagente</small>}</h3>
    <Subject request={request} />
    <div className="phone-actions">
      <button type="button" disabled={busy} onClick={() => onDecide({ behavior: 'deny' })}>Recusar</button>
      <button type="button" className="primary" disabled={busy || !armed} onClick={() => onDecide({ behavior: 'allow' })}>Permitir uma vez</button>
    </div>
  </section>;
}

function Questions({ questions, busy, onDecide }: { questions: Question[]; busy: boolean; onDecide: Props['onDecide'] }) {
  const [chosen, setChosen] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  // A typed answer replaces a single choice and joins a multiple one.
  const answer = (index: number) => {
    const typed = other[index]?.trim();
    const picked = chosen[index] ?? [];
    return (questions[index].multiSelect ? [...picked, ...(typed ? [typed] : [])] : typed ? [typed] : picked).join(', ');
  };
  const complete = questions.every((_, index) => answer(index));
  return <form className="phone-request" aria-label="Pergunta do agente" onSubmit={(event) => {
    event.preventDefault();
    if (complete) onDecide({ behavior: 'answer', answers: Object.fromEntries(questions.map((question, index) => [question.question, answer(index)])) });
  }}>
    <h3>O agente precisa de uma decisão</h3>
    {questions.map((question, index) => <fieldset key={question.question} disabled={busy}>
      <legend>{question.question}</legend>
      {question.options.map((option) => {
        const checked = (chosen[index] ?? []).includes(option.label) && (question.multiSelect || !other[index]?.trim());
        return <label key={option.label} className="phone-option">
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
      <input type="text" aria-label={`Outra resposta para: ${question.question}`} placeholder="Outra resposta…" value={other[index] ?? ''} onChange={(event) => setOther((current) => ({ ...current, [index]: event.target.value }))} />
    </fieldset>)}
    <div className="phone-actions">
      <button type="button" disabled={busy} onClick={() => onDecide({ behavior: 'deny' })}>Não responder</button>
      <button type="submit" className="primary" disabled={busy || !complete}>Enviar resposta</button>
    </div>
  </form>;
}

function Plan({ request, busy, onDecide }: Props) {
  return <section className="phone-request" role="group" aria-label="Plano para aprovação">
    <h3>Plano aguardando aprovação</h3>
    {typeof request.toolInput?.plan === 'string' && <Text text={request.toolInput.plan} />}
    <p className="phone-muted">Aprovar um plano define o modo de execução, por isso é feito no computador.</p>
    <div className="phone-actions"><button type="button" disabled={busy} onClick={() => onDecide({ behavior: 'deny' })}>Continuar planejando</button></div>
  </section>;
}

export function RequestCard(props: Props) {
  const questions = props.request.toolName === 'AskUserQuestion' ? readQuestions(props.request.toolInput) : undefined;
  if (questions?.length) return <Questions questions={questions} busy={props.busy} onDecide={props.onDecide} />;
  if (props.request.toolName === 'ExitPlanMode') return <Plan {...props} />;
  return <Permission {...props} />;
}
