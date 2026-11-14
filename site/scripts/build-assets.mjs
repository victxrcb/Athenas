// Gera os assets da página a partir do material do vídeo de divulgação.
// Uso (na raiz do repositório): node site/scripts/build-assets.mjs [--skip-video]
// Requer: promo/video/public/shots/*.png (node promo/capture/capture.mjs) e promo/out/*.mp4.
import sharp from 'sharp';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shots = path.join(root, 'promo/video/public/shots');
const out = path.join(root, 'site/assets');
for (const dir of ['screens', 'video', 'fonts']) mkdirSync(path.join(out, dir), { recursive: true });

const SCREENS = [
  'home', 'home-noart', 'project-auto', 'layout-popover', 'mapping-terminal', 'mapping-architecture',
  'orchestrator', 'orch-diff', 'git-changes', 'mcp', 'skills', 'usage', 'palette', 'settings-sidebar',
  ...['preto-branco', 'catedral', 'ametista', 'floresta', 'ambar', 'oceano', 'grafite', 'rose', 'menta', 'crepusculo', 'meia-noite', 'pergaminho', 'nevoa'].map((id) => `theme-home-${id}`),
];
const MASCOTS = ['none', 'beach', 'halloween', 'christmas', 'party', 'formal', 'pirate', 'winter'].map((id) => `mascot-${id}`);

const kb = (file) => `${Math.round(statSync(file).size / 1024)} KB`;

for (const name of SCREENS) {
  const target = path.join(out, 'screens', `${name}.webp`);
  await sharp(path.join(shots, `${name}.png`)).resize({ width: name.startsWith('theme-home-') ? 1280 : 1920 }).webp({ quality: 84, effort: 6 }).toFile(target);
  console.log('screen', name, kb(target));
}
for (const name of MASCOTS) {
  const target = path.join(out, 'screens', `${name}.webp`);
  await sharp(path.join(shots, `${name}.png`)).resize({ width: 760 }).webp({ quality: 88, effort: 6 }).toFile(target);
  console.log('mascot', name, kb(target));
}
// Imagem de compartilhamento (Open Graph): 1200x630.
await sharp(path.join(shots, 'project-auto.png')).resize(1200, 630, { fit: 'cover', position: 'top' }).jpeg({ quality: 82 }).toFile(path.join(out, 'og.jpg'));

await sharp(path.join(root, 'src/assets/brand/icon.png')).resize(256, 256).png({ compressionLevel: 9 }).toFile(path.join(out, 'icon.png'));
await sharp(path.join(root, 'src/assets/brand/codex-icon.png')).resize(128, 128).png({ compressionLevel: 9 }).toFile(path.join(out, 'codex.png'));
await sharp(path.join(root, 'src/assets/brand/icon.png')).resize(64, 64).png().toFile(path.join(out, 'favicon.png'));

const FONTS = [
  ['cinzel', 'cinzel-latin-500-normal.woff2'], ['cinzel', 'cinzel-latin-700-normal.woff2'],
  ['inter', 'inter-latin-400-normal.woff2'], ['inter', 'inter-latin-500-normal.woff2'], ['inter', 'inter-latin-600-normal.woff2'], ['inter', 'inter-latin-700-normal.woff2'],
  ['jetbrains-mono', 'jetbrains-mono-latin-400-normal.woff2'], ['jetbrains-mono', 'jetbrains-mono-latin-500-normal.woff2'],
];
for (const [pkg, file] of FONTS) copyFileSync(path.join(root, 'node_modules/@fontsource', pkg, 'files', file), path.join(out, 'fonts', file));

if (!process.argv.includes('--skip-video')) {
  const video = path.join(root, 'promo/video');
  const ffmpeg = (args) => execFileSync('npx', ['remotion', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: video, stdio: 'inherit', shell: true });
  for (const [lang, source] of [['pt', 'athenas-agent-promo.mp4'], ['en', 'athenas-agent-promo-en.mp4']]) {
    const input = path.join(root, 'promo/out', source);
    if (!existsSync(input)) throw new Error(`Vídeo não encontrado: ${input}`);
    const target = path.join(out, 'video', `athenas-${lang}.mp4`);
    const crf = process.env.CRF ?? '27';
    ffmpeg(['-i', input, '-c:v', 'libx264', '-crf', crf, '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k', target]);
    const poster = path.join(out, 'video', `poster-${lang}.png`);
    ffmpeg(['-ss', '3.4', '-i', input, '-frames:v', '1', poster]);
    await sharp(poster).webp({ quality: 82 }).toFile(poster.replace('.png', '.webp'));
    execFileSync(process.execPath, ['-e', `require('fs').unlinkSync(${JSON.stringify(poster)})`]);
    console.log('video', lang, kb(target));
  }
}
