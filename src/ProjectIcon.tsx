import { Folder } from 'lucide-react';

/** Project avatar: the uploaded image when there is one, otherwise the default folder. */
export function ProjectIcon({ icon, size = 14 }: { icon?: string | null; size?: number }) {
  if (!icon) return <Folder size={size} />;
  return <img className="project-icon-img" src={icon} width={size} height={size} alt="" draggable={false} />;
}

const ICON_SIZE = 128;

/** Crops the picture to a square, shrinks it and returns a small PNG data URL ready to store. */
export async function imageToIcon(file: File): Promise<string> {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') {
    throw new Error('Escolha uma imagem PNG, JPG ou WebP.');
  }
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Não foi possível processar a imagem.');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, ICON_SIZE, ICON_SIZE);
    return canvas.toDataURL('image/png');
  } finally {
    bitmap.close();
  }
}
