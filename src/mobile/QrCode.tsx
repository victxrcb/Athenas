import qrcode from 'qrcode-generator';

/** Scanners need dark modules on a light background, so these two colors do not follow the theme. */
export function QrCode({ value, label }: { value: string; label: string }) {
  const code = qrcode(0, 'M');
  code.addData(value);
  code.make();
  const size = code.getModuleCount();
  const quiet = 4;
  let path = '';
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      if (code.isDark(row, column)) path += `M${column + quiet} ${row + quiet}h1v1h-1z`;
    }
  }
  const full = size + quiet * 2;
  return <svg className="mobile-qr" viewBox={`0 0 ${full} ${full}`} role="img" aria-label={label} shapeRendering="crispEdges">
    <rect width={full} height={full} fill="#fff" /><path d={path} fill="#000" />
  </svg>;
}
