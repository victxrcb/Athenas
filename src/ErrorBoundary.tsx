import { Component, type ErrorInfo, type ReactNode } from 'react';

type State = { error: Error | null };

export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Erro de interface:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" style={{ padding: 24, color: 'var(--text, #ededed)', background: 'var(--surface-0, #0a0a0a)', fontFamily: 'var(--font-ui, Inter, sans-serif)', overflow: 'auto', height: '100%' }}>
        <h2 style={{ color: 'var(--error, #e5534b)' }}>{this.props.label ?? 'Algo deu errado'}</h2>
        <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>{error.stack ?? error.message}</pre>
        <button className="button-quiet" onClick={() => this.setState({ error: null })}>Tentar de novo</button>
      </div>
    );
  }
}
