/**
 * Slack Adapter — implements BaseChannelAdapter for Slack Bot API.
 *
 * Uses Slack Bolt SDK with Socket Mode for real-time message consumption
 * (no public URL required), and Web API for message sending. Routes
 * messages through an internal async queue (same pattern as Discord).
 *
 * IMPORTANT: @slack/bolt is loaded via dynamic import() to avoid bundler
 * issues with native modules at build time. All Slack types are referenced
 * via `any` at the class level and resolved at runtime in start().
 */

import crypto from 'crypto';
import type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  PreviewCapabilities,
  SendResult,
} from '../types.js';
import type { FileAttachment } from '../types.js';
import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter.js';
import { getBridgeContext } from '../context.js';

/** Max number of message IDs to keep for dedup. */
const DEDUP_MAX = 1000;

/** Slack message character limit. */
const SLACK_CHAR_LIMIT = 40000;

/** Default max attachment download size (20 MB). */
const DEFAULT_MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;

/** Typing indicator: not natively supported in Slack, but we can post a
 *  temporary "thinking..." message — skipped for now to keep it clean. */

/** Interaction TTL for answerCallback (60s). */
const INTERACTION_TTL_MS = 60_000;

/**
 * Lazily loaded @slack/bolt module reference.
 * Populated in start() via dynamic import to avoid bundler issues.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let slackBolt: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let slackWebApi: any = null;

async function loadSlackBolt() {
  if (!slackBolt) {
    slackBolt = await import('@slack/bolt');
  }
  return slackBolt;
}

async function loadSlackWebApi() {
  if (!slackWebApi) {
    slackWebApi = await import('@slack/web-api');
  }
  return slackWebApi;
}

export class SlackAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'slack';

  private running = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private app: any = null;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private seenMessageIds = new Set<string>();
  private botUserId: string | null = null;
  /** Preview: store message ts per chat for edit-based streaming. */
  private previewMessages = new Map<string, string>();
  /** Chats where preview has permanently failed. */
  private previewDegraded = new Set<string>();
  /** Pending action payloads for answerCallback. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pendingActions = new Map<string, { ack: () => Promise<void>; respond: any; expiresAt: number }>();

  // ── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[slack-adapter] Cannot start:', configError);
      return;
    }

    const { store } = getBridgeContext();
    const botToken = store.getSetting('bridge_slack_bot_token') || '';
    const appToken = store.getSetting('bridge_slack_app_token') || '';

    // Dynamic import to avoid bundler resolving native modules
    const bolt = await loadSlackBolt();

    this.app = new bolt.App({
      token: botToken,
      appToken: appToken,
      socketMode: true,
      // Disable built-in receiver logging to reduce noise
      logLevel: 'WARN',
    });

    // Register event handlers

    // Listen to all messages
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.app.message(async ({ message, say, context }: any) => {
      try {
        await this.handleMessage(message, context);
      } catch (err) {
        console.error('[slack-adapter] message handler error:', err instanceof Error ? err.message : err);
      }
    });

    // Listen to interactive button actions (permission approvals)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.app.action(/^perm_/, async ({ action, body, ack, respond }: any) => {
      try {
        await this.handleAction(action, body, ack, respond);
      } catch (err) {
        console.error('[slack-adapter] action handler error:', err instanceof Error ? err.message : err);
      }
    });

    // Start the Socket Mode connection
    await this.app.start();

    // Get bot user ID for self-message filtering
    try {
      const authResult = await this.app.client.auth.test();
      this.botUserId = authResult.user_id || null;
    } catch {
      console.warn('[slack-adapter] Could not determine bot user ID');
    }

    this.running = true;
    console.log('[slack-adapter] Started (botUserId:', this.botUserId || 'unknown', ')');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Stop the Bolt app
    if (this.app) {
      try {
        await this.app.stop();
      } catch (err) {
        console.warn('[slack-adapter] App stop error:', err instanceof Error ? err.message : err);
      }
      this.app = null;
    }

    // Reject all waiting consumers
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];

    // Clear state
    this.seenMessageIds.clear();
    this.pendingActions.clear();
    this.previewMessages.clear();
    this.previewDegraded.clear();

    console.log('[slack-adapter] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Queue ───────────────────────────────────────────────────

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    if (!this.running) return Promise.resolve(null);

    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  // ── Send ────────────────────────────────────────────────────

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.app) {
      return { ok: false, error: 'Slack app not initialized' };
    }

    try {
      let text = message.text;

      // Convert HTML to Slack mrkdwn if needed
      if (message.parseMode === 'HTML') {
        text = this.htmlToSlackMrkdwn(text);
      }

      // Build message payload
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload: any = {
        channel: message.address.chatId,
        text: text.slice(0, SLACK_CHAR_LIMIT),
      };

      // Thread reply if we have a replyToMessageId (which is a Slack ts)
      if (message.replyToMessageId) {
        payload.thread_ts = message.replyToMessageId;
      }

      // Build inline buttons as Slack Block Kit
      if (message.inlineButtons && message.inlineButtons.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const blocks: any[] = [];

        // Add text as a section block
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: text.slice(0, 3000), // Block Kit text limit
          },
        });

        // Add buttons as actions blocks
        for (const row of message.inlineButtons) {
          const elements = row.map(btn => ({
            type: 'button',
            text: {
              type: 'plain_text',
              text: btn.text,
              emoji: true,
            },
            action_id: btn.callbackData,
            value: btn.callbackData,
          }));

          blocks.push({
            type: 'actions',
            elements,
          });
        }

        payload.blocks = blocks;
      }

      const result = await this.app.client.chat.postMessage(payload);
      return { ok: result.ok, messageId: result.ts };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    const entry = this.pendingActions.get(callbackQueryId);
    if (!entry) return;

    this.pendingActions.delete(callbackQueryId);

    try {
      if (entry.respond) {
        await entry.respond({
          text: text || 'OK',
          replace_original: false,
          response_type: 'ephemeral',
        });
      }
    } catch {
      // Action may have expired — non-critical
    }
  }

  // ── Streaming preview ──────────────────────────────────────

  getPreviewCapabilities(chatId: string): PreviewCapabilities | null {
    // Global kill switch
    if (getBridgeContext().store.getSetting('bridge_slack_stream_enabled') === 'false') return null;

    // Already degraded for this chat
    if (this.previewDegraded.has(chatId)) return null;

    return { supported: true, privateOnly: false };
  }

  async sendPreview(chatId: string, text: string, _draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    if (!this.app) return 'skip';

    const existingTs = this.previewMessages.get(chatId);

    try {
      if (existingTs) {
        // Edit existing preview message
        await this.app.client.chat.update({
          channel: chatId,
          ts: existingTs,
          text: text.slice(0, SLACK_CHAR_LIMIT),
        });
        return 'sent';
      } else {
        // Send new preview message
        const result = await this.app.client.chat.postMessage({
          channel: chatId,
          text: text.slice(0, SLACK_CHAR_LIMIT),
        });
        if (result.ok && result.ts) {
          this.previewMessages.set(chatId, result.ts);
        }
        return 'sent';
      }
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const code = (err as any)?.data?.error;
      if (code === 'channel_not_found' || code === 'not_in_channel' || code === 'is_archived') {
        this.previewDegraded.add(chatId);
        return 'degrade';
      }
      return 'skip';
    }
  }

  endPreview(chatId: string, _draftId: number): void {
    const ts = this.previewMessages.get(chatId);
    if (ts && this.app) {
      // Delete the preview message — the final response replaces it
      this.app.client.chat.delete({
        channel: chatId,
        ts,
      }).catch(() => {});
    }
    this.previewMessages.delete(chatId);
  }

  // ── Config & Auth ───────────────────────────────────────────

  validateConfig(): string | null {
    const { store } = getBridgeContext();

    const enabled = store.getSetting('bridge_slack_enabled');
    if (enabled !== 'true') return 'bridge_slack_enabled is not true';

    const botToken = store.getSetting('bridge_slack_bot_token');
    if (!botToken) return 'bridge_slack_bot_token not configured';

    const appToken = store.getSetting('bridge_slack_app_token');
    if (!appToken) return 'bridge_slack_app_token not configured (required for Socket Mode)';

    return null;
  }

  isAuthorized(userId: string, chatId: string): boolean {
    const { store } = getBridgeContext();
    const allowedUsers = store.getSetting('bridge_slack_allowed_users') || '';
    const allowedChannels = store.getSetting('bridge_slack_allowed_channels') || '';

    // Default-deny: if both are empty, deny all
    if (!allowedUsers && !allowedChannels) return false;

    const users = allowedUsers.split(',').map(s => s.trim()).filter(Boolean);
    const channels = allowedChannels.split(',').map(s => s.trim()).filter(Boolean);

    // If users list is configured, check if user is in it
    if (users.length > 0 && users.includes(userId)) return true;

    // If channels list is configured, check if chat is in it
    if (channels.length > 0 && channels.includes(chatId)) return true;

    // If only one list is configured and the other is empty, check only the configured one
    if (users.length > 0 && channels.length === 0) return false;
    if (channels.length > 0 && users.length === 0) return false;

    return false;
  }

  // ── Incoming event handlers ────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleMessage(message: any, context: any): Promise<void> {
    // Filter out bot messages, subtypes (edits, joins, etc.)
    if (message.subtype) return;
    if (message.bot_id) return;
    if (this.botUserId && message.user === this.botUserId) return;

    const messageId = message.client_msg_id || message.ts || crypto.randomUUID();

    // Dedup by message ID
    if (this.seenMessageIds.has(messageId)) return;
    this.addToDedup(messageId);

    const chatId = message.channel;
    const userId = message.user || '';
    const displayName = message.user || 'unknown';

    // Authorization check
    if (!this.isAuthorized(userId, chatId)) return;

    // Extract text content
    let text = message.text || '';

    // Strip bot mention from text (e.g. <@U12345>)
    if (this.botUserId) {
      text = text.replace(new RegExp(`<@${this.botUserId}>`, 'g'), '').trim();
    }

    // Normalize ! commands to / commands
    if (text.startsWith('!')) {
      text = '/' + text.slice(1);
    }

    // Handle file attachments (images)
    const attachments: FileAttachment[] = [];
    const imageEnabled = getBridgeContext().store.getSetting('bridge_slack_image_enabled') !== 'false';
    const maxSize = parseInt(getBridgeContext().store.getSetting('bridge_slack_max_attachment_size') || '', 10) || DEFAULT_MAX_ATTACHMENT_SIZE;
    const botToken = getBridgeContext().store.getSetting('bridge_slack_bot_token') || '';

    if (imageEnabled && message.files && message.files.length > 0) {
      for (const file of message.files) {
        if (!file.mimetype?.startsWith('image/')) continue;
        if (file.size > maxSize) {
          console.warn(`[slack-adapter] File too large (${file.size} > ${maxSize}), skipping`);
          continue;
        }

        try {
          // Slack files require bot token auth to download
          const url = file.url_private_download || file.url_private;
          if (!url) continue;

          const res = await fetch(url, {
            headers: { Authorization: `Bearer ${botToken}` },
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) continue;

          const buffer = Buffer.from(await res.arrayBuffer());
          const base64 = buffer.toString('base64');
          const id = crypto.randomUUID();

          attachments.push({
            id,
            name: file.name || `image.${file.filetype || 'png'}`,
            type: file.mimetype || 'image/png',
            size: buffer.length,
            data: base64,
          });
        } catch (err) {
          console.warn('[slack-adapter] File download failed:', err instanceof Error ? err.message : err);
        }
      }
    }

    if (!text.trim() && attachments.length === 0) return;

    const address = {
      channelType: 'slack' as const,
      chatId,
      userId,
      displayName,
    };

    const inbound: InboundMessage = {
      messageId,
      address,
      text: text.trim(),
      timestamp: parseFloat(message.ts) * 1000 || Date.now(),
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    // Audit log
    try {
      const summary = attachments.length > 0
        ? `[${attachments.length} attachment(s)] ${text.slice(0, 150)}`
        : text.slice(0, 200);
      getBridgeContext().store.insertAuditLog({
        channelType: 'slack',
        chatId,
        direction: 'inbound',
        messageId,
        summary,
      });
    } catch { /* best effort */ }

    this.enqueue(inbound);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleAction(action: any, body: any, ack: () => Promise<void>, respond: any): Promise<void> {
    // Acknowledge immediately to avoid 3s timeout
    await ack();

    const callbackData = action.action_id || action.value;
    const chatId = body.channel?.id || body.container?.channel_id || '';
    const userId = body.user?.id || '';
    const displayName = body.user?.username || body.user?.name || '';

    if (!this.isAuthorized(userId, chatId)) return;

    // Store action context for answerCallback with TTL
    const actionId = `slack-${body.trigger_id || action.action_id}-${Date.now()}`;
    this.pendingActions.set(actionId, {
      ack: async () => {},
      respond,
      expiresAt: Date.now() + INTERACTION_TTL_MS,
    });

    // Clean up expired actions
    this.cleanupExpiredActions();

    const callbackMessageId = body.message?.ts || body.container?.message_ts;

    const inbound: InboundMessage = {
      messageId: actionId,
      address: {
        channelType: 'slack',
        chatId,
        userId,
        displayName,
      },
      text: '',
      timestamp: Date.now(),
      callbackData,
      callbackMessageId,
    };

    this.enqueue(inbound);
  }

  // ── Utilities ───────────────────────────────────────────────

  private addToDedup(messageId: string): void {
    this.seenMessageIds.add(messageId);

    if (this.seenMessageIds.size > DEDUP_MAX) {
      const excess = this.seenMessageIds.size - DEDUP_MAX;
      let removed = 0;
      for (const id of this.seenMessageIds) {
        if (removed >= excess) break;
        this.seenMessageIds.delete(id);
        removed++;
      }
    }
  }

  private cleanupExpiredActions(): void {
    const now = Date.now();
    for (const [id, entry] of this.pendingActions) {
      if (entry.expiresAt < now) {
        this.pendingActions.delete(id);
      }
    }
  }

  /**
   * Convert simple HTML tags to Slack mrkdwn format.
   * Handles the common tags used in bridge-manager command responses.
   */
  private htmlToSlackMrkdwn(html: string): string {
    return html
      .replace(/<b>(.*?)<\/b>/gi, '*$1*')
      .replace(/<strong>(.*?)<\/strong>/gi, '*$1*')
      .replace(/<i>(.*?)<\/i>/gi, '_$1_')
      .replace(/<em>(.*?)<\/em>/gi, '_$1_')
      .replace(/<code>(.*?)<\/code>/gi, '`$1`')
      .replace(/<pre>([\s\S]*?)<\/pre>/gi, '```\n$1\n```')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''); // Strip remaining HTML tags
  }
}

// Self-register so bridge-manager can create SlackAdapter via the registry.
registerAdapterFactory('slack', () => new SlackAdapter());
