import { MASCOT_ANTENNA_PIXELS, MASCOT_BLUSH_PIXELS, MASCOT_BODY, MASCOT_EYE_PIXELS, outfitPixels, type MascotConfig } from './mascot';

/** Pixel-art mascot. Renders the given config; callers pick the size. */
export function MascotIcon({ config, size = 15, className = 'agent-icon claude' }: { config: MascotConfig; size?: number; className?: string }) {
  const outfit = outfitPixels(config.outfit);
  const hatHeight = Math.max(0, ...outfit.map(([, y]) => -y));
  // A hat replaces the antennas; both would overlap above the head.
  const antennas = config.antennas && hatHeight === 0;
  const top = Math.max(antennas ? 2 : 0, hatHeight);
  const rows = MASCOT_BODY.length + top;
  const pixel = (x: number, y: number, fill: string, key: string) => <rect key={key} x={x} y={y + top} width="1" height="1" fill={fill} />;
  return <svg className={className} width={size * 13 / rows} height={size} viewBox={`0 0 13 ${rows}`} shapeRendering="crispEdges" aria-hidden="true">
    {MASCOT_BODY.flatMap((row, y) => [...row].map((cell, x) => cell === '#' ? pixel(x, y, config.color, `b${x}-${y}`) : null))}
    {antennas && MASCOT_ANTENNA_PIXELS.map(([x, y]) => pixel(x, y, config.color, `a${x}-${y}`))}
    {config.blush && MASCOT_BLUSH_PIXELS.map(([x, y]) => <rect key={`h${x}-${y}`} x={x} y={y + top} width="1" height="1" fill="#fff" opacity="0.35" />)}
    {MASCOT_EYE_PIXELS[config.eyes].map(([x, y]) => pixel(x, y, '#10181a', `e${x}-${y}`))}
    {outfit.map(([x, y, fill], index) => pixel(x, y, fill, `o${index}`))}
  </svg>;
}
