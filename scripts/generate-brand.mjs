import sharp from 'sharp';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = 'C:/Program Files (x86)/Steam/steamapps/workshop/content/431960/3738303708/preview.jpg';
const assets = new URL('../src/assets/brand/', import.meta.url);
const publicDir = new URL('../public/', import.meta.url);
await mkdir(assets, { recursive: true });
await mkdir(publicDir, { recursive: true });
await copyFile(source, new URL('hera-source.jpg', assets));

const crop = await sharp(source).extract({ left: 205, top: 80, width: 600, height: 600 }).resize(1024, 1024).normalize().png().toBuffer();
const circle = Buffer.from('<svg width="1024" height="1024"><circle cx="512" cy="512" r="500" fill="white"/></svg>');
await sharp(crop).composite([{ input: circle, blend: 'dest-in' }]).png().toFile(fileURLToPath(new URL('icon.png', assets)));
await sharp(fileURLToPath(new URL('icon.png', assets))).resize(128, 128).png().toFile(fileURLToPath(new URL('ui-logo.png', assets)));
await sharp(fileURLToPath(new URL('icon.png', assets))).resize(32, 32).toFile(fileURLToPath(new URL('favicon.png', publicDir)));

const width = 96;
const height = 76;
const { data } = await sharp(source).resize(width, height, { fit: 'fill' }).greyscale().normalize().raw().toBuffer({ resolveWithObject: true });
const chars = '@%#*+=-:. ';
const escapeXml = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const lines = [];
for (let y = 0; y < height; y++) {
  let line = '';
  for (let x = 0; x < width; x++) {
    const value = data[y * width + x];
    line += chars[Math.min(chars.length - 1, Math.floor(value / 256 * chars.length))];
  }
  lines.push(`<text x="0" y="${(y + 1) * 11}">${escapeXml(line)}</text>`);
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width * 7} ${height * 11}" preserveAspectRatio="xMidYMid meet"><rect width="100%" height="100%" fill="#0b0b0d"/><g fill="#a29d92" font-family="monospace" font-size="10" xml:space="preserve">${lines.join('')}</g></svg>`;
await writeFile(new URL('hera-ascii.svg', assets), svg);
console.log('Brand assets generated');
