---
name: add-local-transcription
description: Add local voice message transcription to NanoClaw using parakeet-mlx (Apple Silicon only). No API keys, no cloud — runs entirely on-device via MLX. Transcribes voice messages (WhatsApp or Telegram) so the agent can read and respond to them.
disable-model-invocation: true
---

# Add Local Voice Transcription (parakeet-mlx)

Transcribes voice messages locally using [parakeet-mlx](https://github.com/senstella/parakeet). No API keys, no cost, no cloud. Requires Apple Silicon Mac. Works with both WhatsApp (baileys) and Telegram (grammY) channels.

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

## Step 0: Detect messaging channel

Check which channel is installed:

```bash
grep -q '"grammy"' package.json && echo "TELEGRAM" || echo "WHATSAPP"
```

This determines which variant to use in Steps 1–3 below. Each step has a **WhatsApp** and **Telegram** variant.

---

## Step 1: Create `src/transcription.ts`

Replace `FFMPEG_PATH`, `PARAKEET_PATH`, and `FFMPEG_DIR` with the resolved values from prerequisites.

The transcription module is **channel-agnostic** — it takes a raw audio buffer and returns text.

```typescript
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const FFMPEG_PATH = 'FFMPEG_PATH';     // e.g. '/opt/homebrew/bin/ffmpeg'
const PARAKEET_PATH = 'PARAKEET_PATH'; // e.g. '/Users/user/.local/bin/parakeet-mlx'
const FFMPEG_DIR = 'FFMPEG_DIR';       // e.g. '/opt/homebrew/bin'
const TIMEOUT_MS = 60_000;

export async function transcribeVoiceMessage(
  buffer: Buffer,
  msgId: string,
): Promise<string> {
  // Use /private/tmp (canonical path) — macOS /tmp is a symlink and tools
  // like parakeet-mlx resolve to /private/tmp, causing path mismatches
  const tmpDir = '/private/tmp';
  const tmpOgg = path.join(tmpDir, `nanoclaw-voice-${msgId}.ogg`);
  const tmpWav = path.join(tmpDir, `nanoclaw-voice-${msgId}.wav`);
  const tmpTxt = path.join(tmpDir, `nanoclaw-voice-${msgId}.txt`);

  try {
    fs.writeFileSync(tmpOgg, buffer);
    logger.info({ msgId }, 'Voice message saved');

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

---

## Step 2: Update `src/index.ts`

### 2a. Add import at top

```typescript
import { transcribeVoiceMessage } from './transcription.js';
```

### 2b. Add voice handling to message handler

#### WhatsApp variant (baileys)

Add `isVoiceMessage` helper (or import from transcription.ts if you prefer):

```typescript
import { proto } from '@whiskeysockets/baileys';

function isVoiceMessage(msg: proto.IWebMessageInfo): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
```

In the `messages.upsert` handler, make callback `async` and add voice handling before `storeMessage`:

```typescript
sock.ev.on('messages.upsert', async ({ messages }) => {
  for (const msg of messages) {
    // ... existing checks ...

    if (registeredGroups[chatJid]) {
      let transcribed: string | undefined;
      if (isVoiceMessage(msg)) {
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          const text = await transcribeVoiceMessage(buffer, msg.key.id || 'unknown');
          transcribed = `[Voice: ${text}]`;
        } catch (err) {
          logger.error({ err, msgId: msg.key.id }, 'Voice transcription failed');
          transcribed = '[Voice Message]';
        }
      }
      storeMessage(msg, chatJid, msg.key.fromMe || false, msg.pushName || undefined, transcribed);
    }
  }
});
```

**Note**: `downloadMediaMessage` is from `@whiskeysockets/baileys`. `WAMessage` type (from the `messages.upsert` callback) is what `downloadMediaMessage` expects.

#### Telegram variant (grammY)

In the `bot.on('message')` handler, add voice handling before `storeMessage`. Voice detection is trivial: `msg.voice !== undefined`.

```typescript
import { TELEGRAM_BOT_TOKEN } from './config.js';

// Inside bot.on('message', async (ctx) => { ... })

    if (registeredGroups[chatId]) {
      let text = msg.text || msg.caption || '';

      // Voice message transcription
      if (msg.voice) {
        try {
          const file = await bot.api.getFile(msg.voice.file_id);
          const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
          const resp = await fetch(url);
          const buffer = Buffer.from(await resp.arrayBuffer());
          const transcript = await transcribeVoiceMessage(buffer, messageId);
          text = `[Voice: ${transcript}]`;
        } catch (err) {
          logger.error({ err, messageId }, 'Voice transcription failed');
          text = '[Voice Message]';
        }
      }

      storeMessage(chatId, messageId, text, sender, senderName, timestamp, isFromMe);
    }
```

**Note**: Telegram provides `.voice` for voice messages (OGG/Opus). Download via `bot.api.getFile()` → fetch from `https://api.telegram.org/file/bot{TOKEN}/{file_path}`. The `TELEGRAM_BOT_TOKEN` import is needed for constructing the download URL.

---

## Step 3: Update `src/db.ts` (WhatsApp only)

**Skip this step for Telegram** — Telegram's `storeMessage` already takes flat args including a text string, so just pass the transcribed text directly (see Step 2b Telegram variant).

For **WhatsApp** (baileys), `storeMessage` takes a `proto.IWebMessageInfo` and extracts content. Add an optional `transcribedContent` parameter:

```typescript
export function storeMessage(
  msg: proto.IWebMessageInfo,
  chatJid: string,
  isFromMe: boolean,
  pushName?: string,
  transcribedContent?: string,
): void {
```

Change content extraction to prefer transcribed content:

```typescript
  const content =
    transcribedContent ||
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    '';
```

---

## Step 4: Build & Restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Step 5: Test

Tell the user:

> Send a voice note in a registered chat. Check logs:
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
2. Revert `src/index.ts`: remove voice handling block, remove `transcribeVoiceMessage` import
3. **WhatsApp only**: Revert `src/db.ts` — remove `transcribedContent` param, restore original content extraction
4. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
5. Optionally: `pip3 uninstall parakeet-mlx`
