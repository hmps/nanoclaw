---
name: add-local-transcription
description: Add local voice message transcription to NanoClaw using parakeet-mlx (Apple Silicon only). No API keys, no cloud — runs entirely on-device via MLX. Transcribes WhatsApp voice notes so the agent can read and respond to them.
disable-model-invocation: true
---

# Add Local Voice Transcription (parakeet-mlx)

Transcribes WhatsApp voice notes locally using [parakeet-mlx](https://github.com/senstella/parakeet). No API keys, no cost, no cloud. Requires Apple Silicon Mac.

## Prerequisites

Verify Apple Silicon:

```bash
uname -m  # must be "arm64"
```

If `x86_64` → **abort**. Tell user: "parakeet-mlx requires Apple Silicon (M1/M2/M3/M4). Use the `add-voice-transcription` skill for cloud-based Whisper instead."

Check dependencies:

```bash
which parakeet-mlx  # if missing: pip3 install parakeet-mlx
which ffmpeg         # if missing: brew install ffmpeg
```

If `parakeet-mlx` is missing, install it:

```bash
pip3 install parakeet-mlx
```

If `ffmpeg` is missing:

```bash
brew install ffmpeg
```

**Resolve full paths** for both binaries (launchd services have minimal PATH):

```bash
PARAKEET_PATH=$(which parakeet-mlx)  # e.g. /Users/user/.local/bin/parakeet-mlx
FFMPEG_PATH=$(which ffmpeg)          # e.g. /opt/homebrew/bin/ffmpeg
FFMPEG_DIR=$(dirname "$FFMPEG_PATH") # e.g. /opt/homebrew/bin
```

Use these absolute paths in the code below. Do NOT rely on PATH lookup at runtime.

Note: First run downloads ~200MB model to `~/.cache/huggingface/hub/`. Warn the user.

---

## Step 1: Create `src/transcription.ts`

Replace `FFMPEG_PATH`, `PARAKEET_PATH`, and `FFMPEG_DIR` with the resolved values from prerequisites.

```typescript
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { downloadMediaMessage, WAMessage, proto } from '@whiskeysockets/baileys';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const FFMPEG_PATH = 'FFMPEG_PATH';     // e.g. '/opt/homebrew/bin/ffmpeg'
const PARAKEET_PATH = 'PARAKEET_PATH'; // e.g. '/Users/user/.local/bin/parakeet-mlx'
const FFMPEG_DIR = 'FFMPEG_DIR';       // e.g. '/opt/homebrew/bin'
const TIMEOUT_MS = 60_000;

export function isVoiceMessage(msg: proto.IWebMessageInfo): boolean {
  return msg.message?.audioMessage?.ptt === true;
}

export async function transcribeVoiceMessage(
  msg: WAMessage,
): Promise<string> {
  const msgId = msg.key.id || 'unknown';
  // Use /private/tmp (canonical path) — macOS /tmp is a symlink and tools
  // like parakeet-mlx resolve to /private/tmp, causing path mismatches
  const tmpDir = '/private/tmp';
  const tmpOgg = path.join(tmpDir, `nanoclaw-voice-${msgId}.ogg`);
  const tmpWav = path.join(tmpDir, `nanoclaw-voice-${msgId}.wav`);
  const tmpTxt = path.join(tmpDir, `nanoclaw-voice-${msgId}.txt`);

  try {
    // Download audio buffer from WhatsApp
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    fs.writeFileSync(tmpOgg, buffer);
    logger.info({ msgId }, 'Voice message downloaded');

    // Convert to WAV (16kHz mono) — parakeet-mlx works best with WAV input
    await execFileAsync(FFMPEG_PATH, [
      '-i', tmpOgg,
      '-ar', '16000',
      '-ac', '1',
      '-y', tmpWav,
    ], { timeout: TIMEOUT_MS });

    // Transcribe — must pass --output-dir (defaults to cwd, not input dir)
    // and env PATH so parakeet-mlx can find ffmpeg (launchd has minimal PATH)
    const env = { ...process.env, PATH: `${FFMPEG_DIR}:${process.env.PATH}` };
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
```

### Critical implementation notes

- **`/private/tmp`**: macOS `/tmp` is a symlink to `/private/tmp`. parakeet-mlx resolves paths canonically, so if you use `/tmp` for the expected output path but parakeet writes to `/private/tmp`, you get ENOENT. Always use `/private/tmp`.
- **`--output-dir`**: parakeet-mlx defaults `--output-dir` to `.` (cwd), NOT the input file's directory. You must pass it explicitly.
- **PATH env**: launchd services have minimal PATH. parakeet-mlx shells out to ffmpeg internally (separate from our ffmpeg conversion). Pass the ffmpeg directory in `env.PATH`.
- **WAMessage type**: `downloadMediaMessage` expects `WAMessage`, not `proto.IWebMessageInfo`. The `messages.upsert` callback already provides `WAMessage[]`.
- **No sock param needed**: `downloadMediaMessage(msg, 'buffer', {})` works without a context/socket argument.

## Step 2: Update `src/db.ts`

In `storeMessage`, add optional `transcribedContent` parameter and prefer it over other content sources.

Change signature:

```typescript
export function storeMessage(
  msg: proto.IWebMessageInfo,
  chatJid: string,
  isFromMe: boolean,
  pushName?: string,
  transcribedContent?: string,
): void {
```

Change content extraction to:

```typescript
  const content =
    transcribedContent ||
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    '';
```

## Step 3: Update `src/index.ts`

### 3a. Add import at top

```typescript
import { isVoiceMessage, transcribeVoiceMessage } from './transcription.js';
```

### 3b. Update `messages.upsert` handler

Make the callback `async` and add voice handling before `storeMessage`:

```typescript
sock.ev.on('messages.upsert', async ({ messages }) => {
  for (const msg of messages) {
    if (!msg.message) continue;
    const rawJid = msg.key.remoteJid;
    if (!rawJid || rawJid === 'status@broadcast') continue;

    const chatJid = translateJid(rawJid);
    const timestamp = new Date(
      Number(msg.messageTimestamp) * 1000,
    ).toISOString();

    storeChatMetadata(chatJid, timestamp);

    if (registeredGroups[chatJid]) {
      let transcribed: string | undefined;
      if (isVoiceMessage(msg)) {
        try {
          const text = await transcribeVoiceMessage(msg);
          transcribed = `[Voice: ${text}]`;
        } catch (err) {
          logger.error({ err, msgId: msg.key.id }, 'Voice transcription failed');
          transcribed = '[Voice Message]';
        }
      }
      storeMessage(
        msg,
        chatJid,
        msg.key.fromMe || false,
        msg.pushName || undefined,
        transcribed,
      );
    }
  }
});
```

## Step 4: Build & Restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Step 5: Test

Tell the user:

> Send a voice note in a registered WhatsApp group. Check logs:
> ```bash
> tail -f logs/nanoclaw.log | grep -i "transcri\|voice"
> ```
> Voice messages appear in DB as `[Voice: <text>]`.

Verify in DB:

```bash
sqlite3 store/messages.db "SELECT content FROM messages WHERE content LIKE '[Voice:%' ORDER BY timestamp DESC LIMIT 3"
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `parakeet-mlx: not found` | `pip3 install parakeet-mlx` or set full path in `PARAKEET_PATH` constant |
| `ffmpeg: not found` (from parakeet) | launchd PATH issue — ensure `FFMPEG_DIR` in `env.PATH` passed to `execFileAsync` |
| `ENOENT: .txt not found` | Two likely causes: (1) missing `--output-dir` flag, (2) `/tmp` vs `/private/tmp` mismatch |
| Timeout (60s) | Long voice note or slow first run (model downloading). Check `~/.cache/huggingface/hub/` |
| Empty transcription | Audio may be too short or corrupted |
| `x86_64` architecture | Not supported. Use `add-voice-transcription` skill (cloud Whisper) instead |
| Model download fails | Check internet. Model downloads to `~/.cache/huggingface/hub/` on first run |

## Removal

1. Delete `src/transcription.ts`
2. Revert `src/db.ts`: remove `transcribedContent` param, restore original content extraction
3. Revert `src/index.ts`: remove voice handling block, remove import, change callback back to sync
4. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
5. Optionally: `pip3 uninstall parakeet-mlx`
