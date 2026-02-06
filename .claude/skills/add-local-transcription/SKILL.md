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

Note: First run downloads ~200MB model to `~/.cache/huggingface/hub/`. Warn the user.

---

## Step 1: Create `src/transcription.ts`

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import type { proto, WASocket } from '@whiskeysockets/baileys';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);
const PARAKEET_BIN = process.env.PARAKEET_BIN || 'parakeet-mlx';
const TRANSCRIBE_TIMEOUT_MS = 60_000;

export function isVoiceMessage(msg: proto.IWebMessageInfo): boolean {
  return msg.message?.audioMessage?.ptt === true;
}

export async function transcribeVoiceMessage(
  msg: proto.IWebMessageInfo,
  sock: WASocket,
): Promise<string> {
  const tmpDir = '/tmp';
  const id = msg.key.id || `voice_${Date.now()}`;
  const audioPath = path.join(tmpDir, `${id}.ogg`);
  const txtPath = path.join(tmpDir, `${id}.txt`);

  try {
    // Download audio from WhatsApp
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { logger: console as any, reuploadRequest: sock.updateMediaMessage },
    ) as Buffer;

    if (!buffer || buffer.length === 0) {
      throw new Error('Empty audio buffer');
    }

    fs.writeFileSync(audioPath, buffer);
    logger.debug({ audioPath, bytes: buffer.length }, 'Downloaded voice message');

    // Run parakeet-mlx
    await execFileAsync(PARAKEET_BIN, ['--output-format', 'txt', audioPath], {
      timeout: TRANSCRIBE_TIMEOUT_MS,
    });

    // parakeet-mlx writes <basename>.txt next to input
    if (!fs.existsSync(txtPath)) {
      throw new Error(`Transcription output not found: ${txtPath}`);
    }

    const transcript = fs.readFileSync(txtPath, 'utf-8').trim();
    if (!transcript) {
      throw new Error('Empty transcription result');
    }

    logger.info({ id, length: transcript.length }, 'Transcribed voice message');
    return transcript;
  } finally {
    // Cleanup temp files
    for (const f of [audioPath, txtPath]) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
}
```

## Step 2: Update `src/db.ts`

In `storeMessage` (line 182), add optional `transcribedContent` parameter and prefer it over other content sources.

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

### 3b. Update `messages.upsert` handler (line 739)

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
      if (isVoiceMessage(msg)) {
        try {
          const transcript = await transcribeVoiceMessage(msg, sock);
          storeMessage(msg, chatJid, msg.key.fromMe || false, msg.pushName || undefined, `[Voice: ${transcript}]`);
        } catch (err) {
          logger.error({ err }, 'Voice transcription failed');
          storeMessage(msg, chatJid, msg.key.fromMe || false, msg.pushName || undefined, '[Voice Message]');
        }
      } else {
        storeMessage(msg, chatJid, msg.key.fromMe || false, msg.pushName || undefined);
      }
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
| `parakeet-mlx: not found` | `pip3 install parakeet-mlx` or set `PARAKEET_BIN` env var to full path |
| `ffmpeg: not found` | `brew install ffmpeg` — required by parakeet for audio conversion |
| Timeout (60s) | Long voice note or slow first run (model downloading). Check `~/.cache/huggingface/hub/` |
| Empty transcription | Audio may be too short or corrupted. Check `/tmp/<id>.ogg` exists before cleanup |
| `x86_64` architecture | Not supported. Use `add-voice-transcription` skill (cloud Whisper) instead |
| Model download fails | Check internet connection. Model downloads to `~/.cache/huggingface/hub/` on first run |

## Removal

1. Delete `src/transcription.ts`
2. Revert `src/db.ts`: remove `transcribedContent` param, restore original content extraction
3. Revert `src/index.ts`: remove voice handling block, remove import, change callback back to sync
4. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
5. Optionally: `pip3 uninstall parakeet-mlx`
