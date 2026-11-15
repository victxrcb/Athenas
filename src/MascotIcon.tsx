import { mascotPixels, type MascotConfig } from './mascot';

/** Pixel-art mascot. Renders the given config; callers pick the size. */
export function MascotIcon({ config, size = 15, className = 'agent-icon claude' }: { config: MascotConfig; size?: number; className?: string }) {
  const { rows, pixels } = mascotPixels(config);
  return <svg className={className} width={size * 13 / rows} height={size} viewBox={`0 0 13 ${rows}`} shapeRendering="crispEdges" aria-hidden="true">
    {pixels.map((pixel) => <rect key={pixel.key} x={pixel.x} y={pixel.y} width="1" height="1" fill={pixel.fill} opacity={pixel.opacity} />)}
  </svg>;
}
