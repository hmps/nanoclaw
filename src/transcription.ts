import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const FFMPEG_PATH = '/opt/homebrew/bin/ffmpeg';
const PARAKEET_PATH = '/Users/hmps/.local/bin/parakeet-mlx';
const TIMEOUT_MS = 60_000;

export async function transcribeVoiceMessage(
  buffer: Buffer,
  msgId: string,
): Promise<string> {
  // Use /private/tmp (canonical path) instead of /tmp symlink for consistency with parakeet output
  const tmpDir = '/private/tmp';
  const tmpOgg = path.join(tmpDir, `nanoclaw-voice-${msgId}.ogg`);
  const tmpWav = path.join(tmpDir, `nanoclaw-voice-${msgId}.wav`);
  const tmpTxt = path.join(tmpDir, `nanoclaw-voice-${msgId}.txt`);

  try {
    fs.writeFileSync(tmpOgg, buffer);
    logger.info({ msgId }, 'Voice message downloaded');

    // Convert to WAV (parakeet-mlx expects WAV input)
    await execFileAsync(FFMPEG_PATH, [
      '-i', tmpOgg,
      '-ar', '16000',
      '-ac', '1',
      '-y', tmpWav,
    ], { timeout: TIMEOUT_MS });

    // Transcribe — env PATH needed so parakeet-mlx can find ffmpeg internally
    const env = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` };
    await execFileAsync(PARAKEET_PATH, [
      '--output-format', 'txt',
      '--output-dir', tmpDir,
      tmpWav,
    ], { timeout: TIMEOUT_MS, env });
    const transcript = fs.readFileSync(tmpTxt, 'utf-8').trim();
    logger.info({ msgId, length: transcript.length }, 'Voice message transcribed');
    return transcript;
  } finally {
    // Clean up temp files
    for (const f of [tmpOgg, tmpWav, tmpTxt]) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
}
