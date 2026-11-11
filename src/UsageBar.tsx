import { AgentIcon } from './AgentIcon';
import { useAppStore } from './store';

const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
const tone = (percent: number) => (percent >= 80 ? 'high' : percent >= 50 ? 'mid' : 'low');

/** Live CPU per running agent plus the total memory of the terminals and the app itself. */
export function UsageBar() {
  const { agents, totalBytes, appBytes } = useAppStore((state) => state.memory);
  return <div className="usage-bar" aria-label="Uso de recursos">
    {agents.map((item) => {
      const percent = Math.round(item.cpuPercent);
      return <span key={item.agent} className={`usage-agent ${tone(percent)}`}
        title={`${item.agent}: CPU ${percent}% · ${megabytes(item.bytes)} · ${item.sessions} ${item.sessions === 1 ? 'sessão' : 'sessões'}`}>
        <AgentIcon agent={item.agent} size={14} />{percent}%
      </span>;
    })}
    <span className="usage-ram" title={`Agentes ${megabytes(totalBytes - appBytes)} · App ${megabytes(appBytes)}`}>{megabytes(totalBytes)}</span>
  </div>;
}
