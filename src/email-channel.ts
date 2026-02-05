/**
 * Email Channel for NanoClaw
 * Polls Gmail for labeled emails and routes them to per-sender agent containers
 */
import fs from 'fs';
import path from 'path';

import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

import {
  EMAIL_LABEL,
  EMAIL_POLL_INTERVAL,
  GMAIL_MCP_DIR,
  GROUPS_DIR,
  MAIN_GROUP_FOLDER,
} from './config.js';
import { runContainerAgent } from './container-runner.js';
import {
  isEmailProcessed,
  markEmailProcessed,
  markEmailResponded,
} from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup, Session } from './types.js';

export interface EmailChannelDependencies {
  getSessions: () => Session;
  saveSessions: (sessions: Session) => void;
}

function loadOAuthClient(): OAuth2Client | null {
  const keysPath = path.join(GMAIL_MCP_DIR, 'gcp-oauth.keys.json');
  const credsPath = path.join(GMAIL_MCP_DIR, 'credentials.json');

  if (!fs.existsSync(keysPath) || !fs.existsSync(credsPath)) {
    logger.warn(
      { keysPath, credsPath },
      'Gmail OAuth files not found, email channel disabled',
    );
    return null;
  }

  const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));

  // Support both installed and web app credential formats
  const clientConfig = keys.installed || keys.web;
  if (!clientConfig) {
    logger.error('Invalid gcp-oauth.keys.json: no installed or web key');
    return null;
  }

  const oauth2 = new OAuth2Client(
    clientConfig.client_id,
    clientConfig.client_secret,
    clientConfig.redirect_uris?.[0],
  );

  oauth2.setCredentials(creds);

  // Auto-refresh: persist updated tokens back to credentials.json
  oauth2.on('tokens', (tokens) => {
    const existing = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    const merged = { ...existing, ...tokens };
    fs.writeFileSync(credsPath, JSON.stringify(merged, null, 2));
    logger.debug('Gmail OAuth tokens refreshed and saved');
  });

  return oauth2;
}

function createGmailClient(): gmail_v1.Gmail | null {
  const auth = loadOAuthClient();
  if (!auth) return null;
  return google.gmail({ version: 'v1', auth });
}

async function ensureLabel(gmail: gmail_v1.Gmail): Promise<string | null> {
  const res = await gmail.users.labels.list({ userId: 'me' });
  const existing = res.data.labels?.find((l) => l.name === EMAIL_LABEL);
  if (existing) return existing.id!;

  // Auto-create the label
  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name: EMAIL_LABEL, labelListVisibility: 'labelShow' },
  });
  logger.info({ label: EMAIL_LABEL }, 'Created Gmail label');
  return created.data.id!;
}

interface ParsedEmail {
  messageId: string;
  threadId: string;
  from: string;
  fromEmail: string;
  subject: string;
  body: string;
}

function parseEmailAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  return match ? match[1] : raw;
}

function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

function decodeBody(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return '';

  // If this part has a body with data, decode it
  if (part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf-8');
  }

  // If multipart, find text/plain first, then text/html
  if (part.parts) {
    const textPart = part.parts.find((p) => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
    }
    const htmlPart = part.parts.find((p) => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      // Strip HTML tags for plain text
      return Buffer.from(htmlPart.body.data, 'base64url')
        .toString('utf-8')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    // Recurse into nested multipart
    for (const sub of part.parts) {
      const result = decodeBody(sub);
      if (result) return result;
    }
  }

  return '';
}

async function checkForNewEmails(
  gmail: gmail_v1.Gmail,
): Promise<ParsedEmail[]> {
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: `label:${EMAIL_LABEL} is:unread`,
    maxResults: 10,
  });

  if (!res.data.messages?.length) return [];

  const emails: ParsedEmail[] = [];
  for (const msg of res.data.messages) {
    const full = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id!,
      format: 'full',
    });

    const headers = full.data.payload?.headers;
    const from = getHeader(headers, 'From');
    const subject = getHeader(headers, 'Subject');
    const body = decodeBody(full.data.payload);

    emails.push({
      messageId: msg.id!,
      threadId: msg.threadId || msg.id!,
      from,
      fromEmail: parseEmailAddress(from),
      subject,
      body: body.slice(0, 10000), // cap body size
    });
  }

  return emails;
}

async function markAsRead(
  gmail: gmail_v1.Gmail,
  messageId: string,
): Promise<void> {
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  });
}

async function sendEmailReply(
  gmail: gmail_v1.Gmail,
  threadId: string,
  to: string,
  subject: string,
  body: string,
  originalMessageId?: string,
): Promise<void> {
  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
  const lines = [
    `To: ${to}`,
    `Subject: ${replySubject}`,
    `Content-Type: text/plain; charset=utf-8`,
  ];
  if (originalMessageId) {
    lines.push(`In-Reply-To: ${originalMessageId}`);
    lines.push(`References: ${originalMessageId}`);
  }
  lines.push('', body);

  const raw = Buffer.from(lines.join('\r\n')).toString('base64url');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId },
  });
}

function getEmailSenderKey(fromEmail: string): string {
  return fromEmail
    .toLowerCase()
    .replace(/[^a-z0-9@.]/g, '')
    .replace(/@/g, '-at-')
    .replace(/\./g, '-');
}

let emailLoopRunning = false;

export function startEmailLoop(deps: EmailChannelDependencies): void {
  if (emailLoopRunning) {
    logger.debug('Email loop already running, skipping duplicate start');
    return;
  }

  const gmail = createGmailClient();
  if (!gmail) {
    logger.info('Gmail client not available, email channel not started');
    return;
  }

  emailLoopRunning = true;
  logger.info(
    { label: EMAIL_LABEL, interval: EMAIL_POLL_INTERVAL },
    'Email channel started',
  );

  let labelVerified = false;

  const loop = async () => {
    try {
      // Verify/create label on first run
      if (!labelVerified) {
        await ensureLabel(gmail);
        labelVerified = true;
      }

      const emails = await checkForNewEmails(gmail);
      if (emails.length > 0) {
        logger.info({ count: emails.length }, 'New emails found');
      }

      for (const email of emails) {
        if (isEmailProcessed(email.messageId)) continue;

        markEmailProcessed(
          email.messageId,
          email.threadId,
          email.fromEmail,
          email.subject,
        );
        await markAsRead(gmail, email.messageId);

        // Build prompt
        const escapeXml = (s: string) =>
          s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

        const prompt = `<email from="${escapeXml(email.from)}" subject="${escapeXml(email.subject)}">\n${escapeXml(email.body)}\n</email>`;

        // Per-sender group folder
        const senderKey = getEmailSenderKey(email.fromEmail);
        const groupFolder = `email-${senderKey}`;
        const groupDir = path.join(GROUPS_DIR, groupFolder);

        // Create group folder and copy email template CLAUDE.md if it doesn't exist
        if (!fs.existsSync(groupDir)) {
          fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
          const templatePath = path.join(GROUPS_DIR, 'email', 'CLAUDE.md');
          if (fs.existsSync(templatePath)) {
            fs.copyFileSync(
              templatePath,
              path.join(groupDir, 'CLAUDE.md'),
            );
          }
        }

        // Build a synthetic RegisteredGroup
        const group: RegisteredGroup = {
          name: `Email: ${email.fromEmail}`,
          folder: groupFolder,
          trigger: 'email',
          added_at: new Date().toISOString(),
        };

        const sessions = deps.getSessions();

        logger.info(
          {
            from: email.fromEmail,
            subject: email.subject,
            groupFolder,
          },
          'Processing email',
        );

        try {
          const output = await runContainerAgent(group, {
            prompt,
            sessionId: sessions[groupFolder],
            groupFolder,
            chatJid: `email:${email.fromEmail}`,
            isMain: false,
          });

          // Persist session
          if (output.newSessionId) {
            sessions[groupFolder] = output.newSessionId;
            deps.saveSessions(sessions);
          }

          if (output.status === 'success' && output.result) {
            await sendEmailReply(
              gmail,
              email.threadId,
              email.fromEmail,
              email.subject,
              output.result,
            );
            markEmailResponded(email.messageId);
            logger.info(
              { to: email.fromEmail, subject: email.subject },
              'Email reply sent',
            );
          } else if (output.status === 'error') {
            logger.error(
              { error: output.error, from: email.fromEmail },
              'Email agent error',
            );
          }
        } catch (err) {
          logger.error(
            { err, from: email.fromEmail },
            'Failed to process email',
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in email loop');
    }

    setTimeout(loop, EMAIL_POLL_INTERVAL);
  };

  loop();
}
