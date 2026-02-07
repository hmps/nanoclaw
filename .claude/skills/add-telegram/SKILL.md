---
name: add-telegram
description: Add Telegram as a messaging channel. Can replace WhatsApp entirely, run alongside as a control channel, or run alongside as a passive output-only channel. Uses grammY library. Triggers on "telegram", "add telegram", "switch to telegram", "telegram bot".
disable-model-invocation: true
---

# Add Telegram Channel

Adds Telegram via [grammY](https://grammy.dev). Three modes:
- **A: Replace WhatsApp** — Remove baileys, Telegram only
- **B: Alongside (control)** — Both channels receive + respond
- **C: Alongside (passive)** — Telegram receives outbound only (scheduled tasks, IPC)

**UX Note:** Use `AskUserQuestion` for all user choices.

## 1. Create Bot & Configure

Tell the user:

> 1. Open Telegram → search **@BotFather** → send `/newbot`
> 2. Copy the **bot token** (looks like `123456:ABC-DEF1234...`)
> 3. Send `/setprivacy` → select your bot → **Disable** (required for group messages)
> 4. If using in a group, add the bot as a member
>
> Give me the bot token when ready.

```bash
echo "TELEGRAM_BOT_TOKEN=TOKEN_HERE" >> .env
echo "TELEGRAM_BOT_USERNAME=USERNAME_HERE" >> .env
```

## 2. Choose Mode (AskUserQuestion)

> How should Telegram integrate with NanoClaw?

1. **Replace WhatsApp** — Remove WhatsApp entirely
2. **Add alongside (control)** — Both channels receive and respond
3. **Add alongside (passive)** — Telegram only receives outbound messages

## 3. Install Dependencies

**Mode A:** `npm uninstall @whiskeysockets/baileys qrcode-terminal && npm install grammy && npm uninstall @types/qrcode-terminal --save-dev`

**Mode B/C:** `npm install grammy`

---

## Mode A: Replace WhatsApp

### A4. `src/config.ts` — Add Telegram config

After the `TRIGGER_PATTERN` export (line 42), add:

```typescript
// Telegram
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || '';
```

### A5. `src/db.ts` — Replace storeMessage

Delete `import { proto } from '@whiskeysockets/baileys';` (line 5).

Replace `storeMessage` (lines 182-213) with flat args — caller handles content extraction and timestamp conversion:

```typescript
export function storeMessage(
  chatId: string,
  messageId: string,
  text: string,
  sender: string,
  senderName: string,
  timestamp: string,
  isFromMe: boolean,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(messageId, chatId, sender, senderName, text, timestamp, isFromMe ? 1 : 0);
}
```

Signature changed: `(msg: proto.IWebMessageInfo, chatJid, isFromMe, pushName?)` → `(chatId, messageId, text, sender, senderName, timestamp, isFromMe)`. Caller passes ISO string timestamp. Update call sites.

### A5b. `src/transcription.ts` — Update if exists

If `src/transcription.ts` exists (from the local transcription skill), it has baileys imports that need updating. See the `add-local-transcription` skill for Telegram-specific instructions.

### A6. `src/index.ts` — Full rewrite of WhatsApp code

#### A6a. Imports (lines 1-45)

Replace baileys imports with:

```typescript
import { Bot } from 'grammy';
```

Add to config imports: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`. Remove baileys-related config imports.

Keep all other imports (`db.js`, `container-runner.js`, etc.) unchanged.

#### A6b. Module variables (lines 47-59)

Replace `let sock: WASocket;` with `let bot: Bot;`. Remove `lidToPhoneMap`, `groupSyncTimerStarted`, `GROUP_SYNC_INTERVAL_MS`.

#### A6c. Delete `translateJid()` (lines 61-74)

No LID translation needed for Telegram.

#### A6d. Replace `setTyping()` (lines 76-82)

```typescript
let typingTimers: Record<string, NodeJS.Timeout> = {};

async function setTyping(chatId: string, isTyping: boolean): Promise<void> {
  if (typingTimers[chatId]) {
    clearInterval(typingTimers[chatId]);
    delete typingTimers[chatId];
  }
  if (!isTyping) return;

  const sendAction = async () => {
    try {
      await bot.api.sendChatAction(Number(chatId), 'typing');
    } catch (err) {
      logger.debug({ chatId, err }, 'Failed to send typing action');
    }
  };
  await sendAction();
  // Telegram typing expires after 5s, repeat every 4s
  typingTimers[chatId] = setInterval(sendAction, 4000);
}
```

#### A6e. Replace `syncGroupMetadata()` (lines 130-161)

Replace `sock.groupFetchAllParticipating()` with iterating `registeredGroups` and calling `bot.api.getChat(Number(chatId))`:

```typescript
async function syncGroupMetadata(force = false): Promise<void> {
  if (!force) {
    const lastSync = getLastGroupSync();
    if (lastSync && Date.now() - new Date(lastSync).getTime() < 24 * 60 * 60 * 1000) return;
  }
  try {
    logger.info('Syncing chat metadata from Telegram...');
    let count = 0;
    for (const chatId of Object.keys(registeredGroups)) {
      try {
        const chat = await bot.api.getChat(Number(chatId));
        const name = 'title' in chat ? chat.title : ('first_name' in chat ? chat.first_name : chatId);
        if (name) { updateChatName(chatId, name); count++; }
      } catch (err) { logger.debug({ chatId, err }, 'Failed to get chat info'); }
    }
    setLastGroupSync();
    logger.info({ count }, 'Chat metadata synced');
  } catch (err) { logger.error({ err }, 'Failed to sync chat metadata'); }
}
```

#### A6f. Update `getAvailableGroups()` (line 172)

Remove `&& c.jid.endsWith('@g.us')` filter — Telegram uses numeric IDs, not JID suffixes.

#### A6g. Replace `sendMessage()` (lines 290-297)

```typescript
async function sendMessage(chatId: string, text: string): Promise<void> {
  try {
    await bot.api.sendMessage(Number(chatId), text);
    logger.info({ chatId, length: text.length }, 'Message sent');
  } catch (err) { logger.error({ chatId, err }, 'Failed to send message'); }
}
```

#### A6h. Replace `connectWhatsApp()` → `connectTelegram()` (lines 653-766)

```typescript
async function connectTelegram(): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) {
    logger.error('TELEGRAM_BOT_TOKEN not set in .env');
    process.exit(1);
  }

  bot = new Bot(TELEGRAM_BOT_TOKEN);

  bot.on('message', async (ctx) => {
    const msg = ctx.message;
    const chatId = String(msg.chat.id);
    const timestamp = new Date(msg.date * 1000).toISOString();
    const messageId = String(msg.message_id);
    const sender = msg.from ? String(msg.from.id) : chatId;
    const senderName = msg.from
      ? (msg.from.first_name + (msg.from.last_name ? ` ${msg.from.last_name}` : ''))
      : 'Unknown';

    // Extract chat name for group discovery
    const chatName = 'title' in msg.chat ? msg.chat.title : undefined;
    storeChatMetadata(chatId, timestamp, chatName);

    if (registeredGroups[chatId]) {
      let text = msg.text || msg.caption || '';

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

      if (msg.photo) {
        try {
          const photo = msg.photo[msg.photo.length - 1];
          const file = await bot.api.getFile(photo.file_id);
          const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
          const resp = await fetch(url);
          const buffer = Buffer.from(await resp.arrayBuffer());

          const group = registeredGroups[chatId];
          const imagesDir = path.join(DATA_DIR, '..', 'groups', group.folder, 'images');
          fs.mkdirSync(imagesDir, { recursive: true });
          const ext = path.extname(file.file_path || '') || '.jpg';
          const filename = `${messageId}${ext}`;
          fs.writeFileSync(path.join(imagesDir, filename), buffer);

          const caption = msg.caption || '';
          text = `[Image: /workspace/group/images/${filename}]${caption ? ' ' + caption : ''}`;
        } catch (err) {
          logger.error({ err, messageId }, 'Photo download failed');
          text = msg.caption || '[Photo]';
        }
      }

      storeMessage(chatId, messageId, text, sender, senderName, timestamp, false);
    }
  });

  bot.start({
    onStart: () => {
      logger.info('Connected to Telegram');
      syncGroupMetadata().catch((err) => logger.error({ err }, 'Initial chat sync failed'));
      startSchedulerLoop({ sendMessage, registeredGroups: () => registeredGroups, getSessions: () => sessions });
      startIpcWatcher();
      startMessageLoop();
      startEmailLoop({
        getSessions: () => sessions,
        saveSessions: (s) => { sessions = s; saveState(); },
        getMainChatJid: () => {
          const mainEntry = Object.entries(registeredGroups).find(
            ([_, group]) => group.folder === MAIN_GROUP_FOLDER
          );
          return mainEntry ? mainEntry[0] : null;
        },
      });
    },
  });
}
```

#### A6i. Update `main()` (line 850)

Replace `await connectWhatsApp()` → `await connectTelegram()`.

### A7. Delete `src/whatsapp-auth.ts`

```bash
rm src/whatsapp-auth.ts
```

### A8. `package.json` — Update auth script

Replace `"auth": "tsx src/whatsapp-auth.ts"` with:
`"auth": "echo 'Set TELEGRAM_BOT_TOKEN in .env (get from @BotFather)'"`

### A9. `container/agent-runner/src/ipc-mcp.ts` — Channel-agnostic

Update tool descriptions:
- `send_message`: "Send a message to the current WhatsApp group" → "Send a message to the current chat"
- `register_group`: "Register a new WhatsApp group" → "Register a new chat"
- "available_groups.json to find the JID" → "available_groups.json to find the chat ID"
- jid describe: `'The WhatsApp JID (e.g., "120363336345536173@g.us")'` → `'The chat ID (e.g., "-1001234567890" for groups)'`

### A9b. `bin/start.sh` — launchd wrapper for `.env` loading

The host process needs `TELEGRAM_BOT_TOKEN` from env. Instead of hardcoding it in the plist, create a wrapper that sources `.env`:

```bash
#!/bin/bash
set -a
source "$(dirname "$0")/../.env"
set +a
exec /path/to/node "$(dirname "$0")/../dist/index.js"
```

Update plist `ProgramArguments` to use `/bin/bash bin/start.sh` instead of invoking node directly. Remove any hardcoded env vars from the plist (like `ASSISTANT_NAME`) — they now come from `.env`.

### A9c. Preserve `containerConfig` from old entry

Before overwriting `registered_groups.json` with the new Telegram chat ID, check the old file for `containerConfig` (especially `additionalMounts`). If present, copy it to the new entry.

Also check `~/.config/nanoclaw/mount-allowlist.json` — if it has `allowedRoots`, ask the user:

> Your mount allowlist has these directories configured:
> - `~/dev` (read-write)
> - `~/ai-workspaces` (read-write)
>
> Do you want the Telegram bot to have access to these same directories?

If yes, add them as `containerConfig.additionalMounts` in the new entry:

```json
"containerConfig": {
  "additionalMounts": [
    { "hostPath": "~/dev", "containerPath": "dev", "readonly": false },
    { "hostPath": "~/ai-workspaces", "containerPath": "ai-workspaces", "readonly": false }
  ]
}
```

### A10. Image support & `.gitignore`

Photos are saved to `groups/{folder}/images/` and referenced as `[Image: /workspace/group/images/{id}.jpg]` in messages. The agent uses its `Read` tool (multimodal) to view them. Add to `.gitignore`:

```
groups/*/images/
groups/*/logs/
groups/*/conversations/
```

Add to `groups/global/CLAUDE.md` and `groups/main/CLAUDE.md` under "What You Can Do":

```
- View images shared in the chat (use the Read tool on `[Image: /path]` references)
```

### A11. Documentation updates

| File | Change |
|------|--------|
| `CLAUDE.md` | "connects to WhatsApp" → "connects to Telegram" |
| `groups/main/CLAUDE.md:95` | "synced from WhatsApp daily" → "synced from Telegram daily" |
| `groups/main/CLAUDE.md:111` | Remove `WHERE jid LIKE '%@g.us' AND` — just `WHERE jid != '__group_sync__'` |
| `groups/main/CLAUDE.md:133` | "WhatsApp JID" → "Telegram chat ID" |

### A12. `.claude/skills/setup/SKILL.md`

**Section 5** — Replace WhatsApp QR auth with Telegram token verification:

```markdown
## 5. Telegram Authentication

Verify the bot token is set:
\`\`\`bash
grep TELEGRAM_BOT_TOKEN .env
\`\`\`

If not set, tell the user to message @BotFather and create a bot. Add to `.env`:
\`\`\`bash
echo "TELEGRAM_BOT_TOKEN=TOKEN_HERE" >> .env
echo "TELEGRAM_BOT_USERNAME=USERNAME_HERE" >> .env
\`\`\`

Verify: `curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" | grep '"ok":true'`
```

**Section 8** — Replace main channel registration (WhatsApp JID discovery → Telegram chat discovery):

Tell user to send a message to the bot in a private chat. Run `timeout 10 npm run dev || true` to capture it. Query: `sqlite3 store/messages.db "SELECT DISTINCT chat_jid FROM messages ORDER BY timestamp DESC LIMIT 5"`. Use the positive number as the chat ID key in `registered_groups.json`.

---

## Mode B: Alongside (Control)

Keep all WhatsApp code. Add Telegram in parallel.

### B4. `src/config.ts`

Same as A4 — add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME`.

### B5. `src/types.ts` — Add channel field

```typescript
export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  channel?: 'whatsapp' | 'telegram';  // ← add this
  containerConfig?: ContainerConfig;
}
```

### B6. `src/db.ts` — Add `storeTelegramMessage()`

Keep existing `storeMessage` for baileys. Add new function after it:

```typescript
export function storeTelegramMessage(
  chatId: string, messageId: string, text: string,
  sender: string, senderName: string, timestamp: number, isFromMe: boolean,
): void {
  const ts = new Date(timestamp * 1000).toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(messageId, chatId, sender, senderName, text, ts, isFromMe ? 1 : 0);
}
```

### B7. `src/index.ts` — Add parallel Telegram

**Imports:** Add `import { Bot } from 'grammy';` and config/db imports for Telegram.

**Variables:** Add `let bot: Bot;` after `let sock: WASocket;`.

**Typing:** Add `setTelegramTyping()` helper (same as A6d body). Update existing `setTyping()` to dispatch:

```typescript
async function setTyping(jid: string, isTyping: boolean): Promise<void> {
  const group = registeredGroups[jid];
  if (group?.channel === 'telegram') {
    await setTelegramTyping(jid, isTyping);
    return;
  }
  try {
    await sock.sendPresenceUpdate(isTyping ? 'composing' : 'paused', jid);
  } catch (err) { logger.debug({ jid, err }, 'Failed to update typing status'); }
}
```

**sendMessage:** Dispatch by channel:

```typescript
async function sendMessage(jid: string, text: string): Promise<void> {
  const group = registeredGroups[jid];
  try {
    if (group?.channel === 'telegram') {
      await bot.api.sendMessage(Number(jid), text);
    } else {
      await sock.sendMessage(jid, { text });
    }
    logger.info({ jid, length: text.length }, 'Message sent');
  } catch (err) { logger.error({ jid, err }, 'Failed to send message'); }
}
```

**getAvailableGroups (line 172):** Relax filter to accept both:

```typescript
.filter((c) => c.jid !== '__group_sync__' && (c.jid.endsWith('@g.us') || /^-?\d+$/.test(c.jid)))
```

**connectTelegram():** Add before `main()`. Same as A6h body but without starting scheduler/IPC/email (those start from `connectWhatsApp`). Just `bot.start({ onStart: () => logger.info('Connected to Telegram') })`.

**main():** Add `await connectTelegram();` after `await connectWhatsApp();`.

### B8. `data/registered_groups.json`

Add Telegram entries with `"channel": "telegram"`. Existing WhatsApp entries default to `'whatsapp'` when `channel` is absent.

**Important:** If existing entries have `containerConfig` (especially `additionalMounts`), preserve it when creating new Telegram entries for the same group. Also check `~/.config/nanoclaw/mount-allowlist.json` for configured directories and ask the user if new Telegram groups should have access.

```json
{
  "120363336345536173@g.us": { "name": "main", "folder": "main", "trigger": "@Pi", "added_at": "..." },
  "-1001234567890": { "name": "tg-group", "folder": "tg-group", "trigger": "@botusername", "channel": "telegram", "added_at": "..." }
}
```

### B9. `container/agent-runner/src/ipc-mcp.ts`

Same as A9 — make `register_group` channel-agnostic.

---

## Mode C: Alongside (Passive)

All Mode B steps, plus one change in `processMessage()` (line 189):

```typescript
// Before:
  if (!isMainGroup && !TRIGGER_PATTERN.test(content)) return;

// After:
  const isTelegramPassive = group.channel === 'telegram' && !isMainGroup;
  if (isTelegramPassive) return; // Passive: outbound only
  if (!isMainGroup && !TRIGGER_PATTERN.test(content)) return;
```

Passive groups only receive messages via scheduled tasks and IPC `send_message`.

---

## Rebuild & Test

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

1. Send message to bot in Telegram
2. Check logs: `tail -f logs/nanoclaw.log`
3. Verify in DB: `sqlite3 store/messages.db "SELECT * FROM messages ORDER BY timestamp DESC LIMIT 5"`
4. Verify response (if control/replace mode)

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Bot not receiving group messages | `/setprivacy` → Disable via @BotFather. Add bot to group. |
| 409 Conflict | Duplicate bot instance running. Check `launchctl list \| grep nanoclaw`. |
| Typing vanishes instantly | Check 4s repeat timer in `setTyping`. Telegram expires at 5s. |
| No response | Check `registered_groups.json` has correct chat ID. Mode B/C: ensure `"channel": "telegram"`. Verify token: `curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe"` |
| Chat ID format | Private: positive number. Groups: negative (e.g., `-1001234567890`). |

## Removal

**Mode A:** `npm uninstall grammy && npm install @whiskeysockets/baileys qrcode-terminal`, restore `whatsapp-auth.ts`, revert all changes.

**Mode B/C:** `npm uninstall grammy`, remove `connectTelegram()`, remove `channel` from types, remove Telegram entries from `registered_groups.json`.

## Changed Files Summary

| File | Mode A | Mode B/C |
|------|--------|----------|
| `src/config.ts` | Add TG config | Same |
| `src/db.ts` | Replace `storeMessage` | Add `storeTelegramMessage` |
| `src/transcription.ts` | Remove baileys dep, new signature | — |
| `src/types.ts` | — | Add `channel` field |
| `src/index.ts` | Replace WA → TG | Add parallel TG |
| `src/whatsapp-auth.ts` | Delete | — |
| `bin/start.sh` | Create (launchd wrapper) | — |
| `package.json` | Swap deps | Add grammy |
| `container/agent-runner/src/ipc-mcp.ts` | Channel-agnostic | Same |
| `groups/main/CLAUDE.md` | Update refs + image instruction | Image instruction |
| `groups/global/CLAUDE.md` | Image instruction | Same |
| `.gitignore` | Add `groups/*/images/` | Same |
| `CLAUDE.md` | Update arch line | — |
| `.claude/skills/setup/SKILL.md` | Update auth + register | — |
| `data/registered_groups.json` | TG chat IDs | Add with `channel` |
