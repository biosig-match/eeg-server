import { extname } from 'node:path';

const EXTENSION_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.json': 'application/json',
  '.csv': 'text/csv',
};

const STIMULUS_TYPE_FALLBACK: Record<string, string> = {
  image: 'image/*',
  audio: 'audio/*',
  video: 'video/*',
  other: 'application/octet-stream',
};

export function resolveStimulusMime(filename: string, stimulusType?: string): string {
  const ext = extname(filename).toLowerCase();

  if (ext && EXTENSION_MIME_MAP[ext]) {
    return EXTENSION_MIME_MAP[ext];
  }

  if (stimulusType) {
    const normalized = stimulusType.toLowerCase();
    if (STIMULUS_TYPE_FALLBACK[normalized]) {
      return STIMULUS_TYPE_FALLBACK[normalized];
    }
  }

  return 'application/octet-stream';
}
