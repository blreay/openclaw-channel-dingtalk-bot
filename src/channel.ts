import axios from 'axios';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_ACCOUNT_ID } from 'openclaw/plugin-sdk/core';
import { createReplyPrefixContext } from 'openclaw/plugin-sdk/channel-message';
import { registerPluginHttpRoute } from 'openclaw/plugin-sdk/webhook-ingress';
import type {
  ChannelMeta,
  ChannelPlugin,
  OpenClawConfig,
  ReplyPayload,
} from 'openclaw/dist/plugin-sdk/index.js';
import { getRuntime } from './runtime';
import { dingtalkSign } from './sign';
import type {
  DingTalkConfig,
  DingTalkInboundMessage,
  DingTalkRichTextNode,
  ResolvedDingTalkAccount,
} from './types';

const DEFAULT_WEBHOOK_PATH = '/dingtalk-channel/message';
const CHANNEL_ID = 'dingtalk';
const DEFAULT_OUTBOUND_TITLE = '[新的消息]';
const OUTBOUND_TITLE_PREVIEW_LENGTH = 15;
const DINGTALK_ROBOT_SEND_API = 'https://oapi.dingtalk.com/robot/send';
const DEFAULT_ACTIVE_OUTBOUND_TARGET = 'default';
const DEFAULT_BLOCK_STREAMING = true;
const DEFAULT_TOOL_PROGRESS_MODE = 'simple';
const TOOL_PROGRESS_THROTTLE_MS = 1500;
const OUTBOUND_DISABLED_ERROR =
  '[dingtalk][outbound-disabled] channels.dingtalk.accessToken is required for active outbound delivery';
const DINGTALK_TARGET_HINT =
  'Use "default" for robot-level outbound, or explicit target id like conversation:<id> / user:<id>.';

const routeUnregisterByAccount = new Map<string, () => void>();

interface DingTalkMentionPayload {
  atUserIds: string[];
}

const meta: ChannelMeta = {
  id: CHANNEL_ID,
  label: 'DingTalk',
  selectionLabel: 'DingTalk (钉钉)',
  docsPath: '/channels/dingtalk',
  docsLabel: 'dingtalk',
  blurb: '钉钉企业内部机器人，使用 Webhook 模式接入 OpenClaw gateway。支持多机器人（多账号）配置。',
  aliases: ['dd', 'ding'],
  order: 70,
};

// ---------------------------------------------------------------------------
// Top-level channel config (the "base" shared by all accounts)
// ---------------------------------------------------------------------------

interface BaseDingTalkChannelConfig {
  enabled: boolean;
  secretKey: string;
  accessToken: string;
  webhookPath: string;
  blockStreaming: boolean;
  toolProgress: 'off' | 'simple';
  toolProgressInGroup: 'off' | 'simple';
  accounts: Record<string, Partial<DingTalkConfig>> | undefined;
}

function parseBaseChannelConfig(cfg: OpenClawConfig): BaseDingTalkChannelConfig {
  const channelCfg = (cfg.channels as Record<string, unknown> | undefined)?.[
    CHANNEL_ID
  ] as Record<string, unknown> | undefined;

  if (!channelCfg) {
    return {
      enabled: true,
      secretKey: '',
      accessToken: '',
      webhookPath: DEFAULT_WEBHOOK_PATH,
      blockStreaming: DEFAULT_BLOCK_STREAMING,
      toolProgress: DEFAULT_TOOL_PROGRESS_MODE,
      toolProgressInGroup: DEFAULT_TOOL_PROGRESS_MODE,
      accounts: undefined,
    };
  }

  const toolProgress =
    (channelCfg.toolProgress ?? DEFAULT_TOOL_PROGRESS_MODE) === 'off' ||
    (channelCfg.toolProgress ?? DEFAULT_TOOL_PROGRESS_MODE) === 'simple'
      ? (channelCfg.toolProgress as string)
      : DEFAULT_TOOL_PROGRESS_MODE;
  const toolProgressInGroup =
    (channelCfg.toolProgressInGroup ?? DEFAULT_TOOL_PROGRESS_MODE) === 'off' ||
    (channelCfg.toolProgressInGroup ?? DEFAULT_TOOL_PROGRESS_MODE) === 'simple'
      ? (channelCfg.toolProgressInGroup as string)
      : DEFAULT_TOOL_PROGRESS_MODE;

  const blockStreaming =
    typeof channelCfg.blockStreaming === 'boolean'
      ? channelCfg.blockStreaming
      : DEFAULT_BLOCK_STREAMING;

  const secretKey =
    typeof channelCfg.secretKey === 'string' ? channelCfg.secretKey.trim() : '';
  const accessToken =
    typeof channelCfg.accessToken === 'string' ? channelCfg.accessToken.trim() : '';
  const webhookPath =
    typeof channelCfg.webhookPath === 'string'
      ? channelCfg.webhookPath.trim()
      : '';

  // Extract the "accounts" sub-object if present
  let accounts: Record<string, Partial<DingTalkConfig>> | undefined = undefined;
  const acctRaw = channelCfg.accounts;
  if (acctRaw && typeof acctRaw === 'object' && !Array.isArray(acctRaw)) {
    accounts = {} as Record<string, Partial<DingTalkConfig>>;
    for (const [accountId, acctCfg] of Object.entries(acctRaw)) {
      if (acctCfg && typeof acctCfg === 'object') {
        const trimmed: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(acctCfg as Record<string, unknown>)) {
          if (typeof v === 'string') {
            trimmed[k] = v.trim();
          } else if (typeof v === 'boolean') {
            trimmed[k] = v;
          } else if (typeof v === 'undefined') {
            // skip
          } else {
            trimmed[k] = v;
          }
        }
        accounts[accountId] = trimmed as Partial<DingTalkConfig>;
      }
    }
  }

  const enabled = channelCfg.enabled === false ? false : true;

  return {
    enabled,
    secretKey,
    accessToken,
    webhookPath: normalizeWebhookPath(webhookPath || DEFAULT_WEBHOOK_PATH),
    blockStreaming,
    toolProgress: toolProgress as 'off' | 'simple',
    toolProgressInGroup: toolProgressInGroup as 'off' | 'simple',
    accounts,
  };
}

function normalizeWebhookPath(raw: string): string {
  return raw.startsWith('/') ? raw : `/${raw}`;
}

// ---------------------------------------------------------------------------
// Per-account resolution: base config + account-specific overrides
// ---------------------------------------------------------------------------

function resolveAccountConfig(
  base: BaseDingTalkChannelConfig,
  accountId: string,
): ResolvedDingTalkAccount {
  // Account-specific overrides (merged into base)
  const acctBase = base.accounts?.[accountId];
  const secretKey = acctBase?.secretKey ?? base.secretKey ?? '';
  const accessToken = acctBase?.accessToken ?? base.accessToken;
  const webhookPath = normalizeWebhookPath(
    acctBase?.webhookPath ?? base.webhookPath ?? DEFAULT_WEBHOOK_PATH,
  );
  const enabled = acctBase?.enabled ?? base.enabled;
  const blockStreaming =
    acctBase?.blockStreaming !== undefined
      ? acctBase.blockStreaming
      : base.blockStreaming;
  const toolProgress =
    (acctBase?.toolProgress as 'off' | 'simple' | undefined) ?? base.toolProgress;
  const toolProgressInGroup =
    (acctBase?.toolProgressInGroup as 'off' | 'simple' | undefined) ??
    base.toolProgressInGroup;

  return {
    accountId,
    enabled,
    secretKey,
    accessToken,
    webhookPath,
    blockStreaming,
    toolProgress,
    toolProgressInGroup,
  };
}

// ---------------------------------------------------------------------------
// Discover all account IDs from config
// ---------------------------------------------------------------------------

/**
 * Return account IDs from the channel config.
 *
 * If base `secretKey` is set, "default" is always an account.
 * Then every key under `accounts.<accountId>` is also an account,
 * even if that key doesn't set its own secretKey (it inherits it).
 *
 * This keeps the API compatible: the user just writes per-account overrides
 * under `channels.dingtalk.accounts.<name>`.
 */
function listDingTalkAccountIds(cfg: OpenClawConfig): string[] {
  const base = parseBaseChannelConfig(cfg);

  // Always include "default" if base config is present (even with empty secretKey,
  // so existing single-account deployments keep working)
  const ids: string[] = [DEFAULT_ACCOUNT_ID];

  // Add each named account from the "accounts" sub-object
  if (base.accounts) {
    for (const accountId of Object.keys(base.accounts)) {
      const normalized = normalizeAccountIdForDingtalk(accountId);
      if (normalized && normalized !== DEFAULT_ACCOUNT_ID) {
        ids.push(normalized);
      }
    }
  }
  return ids;
}

const DINGTALK_ACCOUNT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const DINGTALK_INV_RE = /[^a-z0-9_-]+/g;

function normalizeAccountIdForDingtalk(value: string): string | undefined {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return undefined;
  const canonical = trimmed.replace(DINGTALK_INV_RE, '-').replace(/^-+/, '').replace(/-+$/, '').slice(0, 64);
  if (!canonical || canonical === DEFAULT_ACCOUNT_ID) return undefined;
  return canonical;
}

// ---------------------------------------------------------------------------
// Inbound verification (unchanged)
// ---------------------------------------------------------------------------

function verifyDingtalkSign(
  req: IncomingMessage,
  secretKey: string,
  maxAgeMs = 60 * 60 * 1000,
): boolean {
  if (!secretKey) return false;
  let query = '';
  try {
    query = new URL(req.url ?? '', 'http://localhost').search ?? '';
  } catch {
    query = (req.url ?? '').split('?')[1] ?? '';
  }
  const params = new URLSearchParams(query);
  const timestamp = params.get('timestamp');
  const sign = params.get('sign');
  if (!timestamp || !sign) return false;
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(Date.now() - tsNum) > maxAgeMs) return false;

  try {
    const crypto = require('crypto');
    const expected = crypto
      .createHmac('sha256', secretKey)
      .update(`${timestamp}\n${secretKey}`)
      .digest('base64');
    const received = decodeURIComponent(sign);
    return expected.length === received.length && expected === received;
  } catch {
    return false;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function respondJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Outbound helpers (unchanged)
// ---------------------------------------------------------------------------

function stripMarkdownToPlainText(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<https?:\/\/[^>]+>/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*([-*+]|[0-9]+\.)\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildOutboundTitle(text: string): string {
  const plainText = stripMarkdownToPlainText(text);
  if (!plainText) {
    return DEFAULT_OUTBOUND_TITLE;
  }
  return Array.from(plainText).slice(0, OUTBOUND_TITLE_PREVIEW_LENGTH).join('');
}

function normalizeDingTalkTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const lowered = trimmed.toLowerCase();
  if (
    lowered === DEFAULT_ACTIVE_OUTBOUND_TARGET ||
    lowered === `#${DEFAULT_ACTIVE_OUTBOUND_TARGET}` ||
    lowered === `channel:${DEFAULT_ACTIVE_OUTBOUND_TARGET}` ||
    lowered === `group:${DEFAULT_ACTIVE_OUTBOUND_TARGET}` ||
    lowered === `chat:${DEFAULT_ACTIVE_OUTBOUND_TARGET}`
  ) {
    return DEFAULT_ACTIVE_OUTBOUND_TARGET;
  }
  return trimmed;
}

function looksLikeDingTalkTargetId(raw: string, normalized?: string): boolean {
  const value = (normalized ?? raw).trim();
  if (!value) return false;
  const lowered = value.toLowerCase();
  if (lowered === DEFAULT_ACTIVE_OUTBOUND_TARGET) return true;
  if (/^(conversation|user|chat|group):/.test(lowered)) return true;
  if (value.startsWith('#') || value.startsWith('@')) return true;
  if (/^cid[\w+/:=.-]*$/i.test(value)) return true;
  if (/^\$:[\w:-]+/i.test(value)) return true;
  return false;
}

function buildActiveOutboundText(params: { text?: string; mediaUrl?: string }): string {
  const text = (params.text ?? '').trim();
  const mediaUrl = (params.mediaUrl ?? '').trim();
  if (text && mediaUrl) return `${text}\n\n${mediaUrl}`;
  if (text) return text;
  if (mediaUrl) return mediaUrl;
  return DEFAULT_OUTBOUND_TITLE;
}

async function sendMarkdownBySessionWebhook(params: {
  sessionWebhook: string;
  secretKey: string;
  text: string;
  mention?: DingTalkMentionPayload;
}): Promise<void> {
  const { sessionWebhook, secretKey, text, mention } = params;
  const { timestamp, sign } = dingtalkSign(secretKey);
  const separator = sessionWebhook.includes('?') ? '&' : '?';
  const signedUrl = `${sessionWebhook}${separator}timestamp=${timestamp}&sign=${sign}`;
  const atUserIds = Array.from(
    new Set(
      (mention?.atUserIds ?? [])
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  );
  const title = buildOutboundTitle(text);

  const response = await axios.post(
    signedUrl,
    {
      msgtype: 'markdown',
      markdown: { title, text },
      at: { atMobiles: [], atUserIds, isAtAll: false },
    },
    { headers: { 'Content-Type': 'application/json' } },
  );

  if (response.data?.errcode !== 0) {
    throw new Error(`DingTalk send failed: ${response.data?.errmsg ?? 'unknown error'}`);
  }
}

async function sendMarkdownByRobotAccessToken(params: {
  accessToken: string;
  secretKey: string;
  text: string;
}): Promise<void> {
  const { accessToken, secretKey, text } = params;
  const { timestamp, sign } = dingtalkSign(secretKey);
  const signedUrl =
    `${DINGTALK_ROBOT_SEND_API}?access_token=${encodeURIComponent(accessToken)}` +
    `&timestamp=${timestamp}&sign=${sign}`;
  const title = buildOutboundTitle(text);

  const response = await axios.post(
    signedUrl,
    {
      msgtype: 'markdown',
      markdown: { title, text },
      at: { atMobiles: [], atUserIds: [], isAtAll: false },
    },
    { headers: { 'Content-Type': 'application/json' } },
  );

  if (response.data?.errcode !== 0) {
    throw new Error(`DingTalk robot send failed: ${response.data?.errmsg ?? 'unknown error'}`);
  }
}

// ---------------------------------------------------------------------------
// Inbound message handling (unchanged)
// ---------------------------------------------------------------------------

async function resolveMessageFileDownloadUrl(params: {
  downloadCode: string;
  robotCode: string;
  accessToken: string;
}): Promise<string> {
  const response = await axios.post<{ downloadUrl?: string }>(
    'https://api.dingtalk.com/v1.0/robot/messageFiles/download',
    {
      downloadCode: params.downloadCode,
      robotCode: params.robotCode,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': params.accessToken,
      },
    },
  );
  return (response.data?.downloadUrl ?? '').trim();
}

function resolveHttpContentType(headers: unknown): string {
  if (!headers || typeof headers !== 'object') return '';
  const headerValue =
    (headers as Record<string, unknown>)['content-type'] ??
    (headers as Record<string, unknown>)['Content-Type'];
  return typeof headerValue === 'string' ? headerValue.trim() : '';
}

async function resolveBufferContentType(params: {
  runtime: any;
  buffer: Buffer;
  fallback: string;
  log: (message: string) => void;
  accountId: string;
}): Promise<string> {
  const { runtime, buffer, fallback, log, accountId } = params;
  try {
    const detectByCore = runtime?.core?.media?.detectMime;
    if (typeof detectByCore === 'function') {
      const maybeMime = await detectByCore({ buffer });
      if (typeof maybeMime === 'string' && maybeMime.trim()) {
        return maybeMime.trim();
      }
    }
  } catch (err) {
    log(`dingtalk[${accountId}] detect mime by core failed: ${String(err)}`);
  }
  try {
    const detectByChannel = runtime?.channel?.media?.detectMime;
    if (typeof detectByChannel === 'function') {
      const maybeMime = await detectByChannel({ buffer });
      if (typeof maybeMime === 'string' && maybeMime.trim()) {
        return maybeMime.trim();
      }
    }
  } catch (err) {
    log(`dingtalk[${accountId}] detect mime by channel failed: ${String(err)}`);
  }
  return fallback || 'application/octet-stream';
}

async function downloadAndSaveRichTextImages(params: {
  runtime: any;
  accountId: string;
  accessToken: string;
  robotCode?: string;
  images: RichTextImageTask[];
  log: (message: string) => void;
}): Promise<InboundSavedMedia[]> {
  const { runtime, accountId, accessToken, robotCode, images, log } = params;
  if (!Array.isArray(images) || images.length === 0) return [];
  const saveMediaBuffer = runtime?.channel?.media?.saveMediaBuffer;
  if (typeof saveMediaBuffer !== 'function') {
    log(`dingtalk[${accountId}] runtime.channel.media.saveMediaBuffer unavailable, skip media`);
    return [];
  }
  const resolvedRobotCode = typeof robotCode === 'string' ? robotCode.trim() : '';
  if (!accessToken || !resolvedRobotCode || resolvedRobotCode === 'normal') return [];
  const out: InboundSavedMedia[] = [];
  for (const image of images) {
    try {
      const downloadUrl = await resolveMessageFileDownloadUrl({
        downloadCode: image.downloadCode,
        robotCode: resolvedRobotCode,
        accessToken,
      });
      if (!downloadUrl) {
        log(`dingtalk[${accountId}] empty downloadUrl for richText image`);
        continue;
      }
      const response = await axios.get<ArrayBuffer>(downloadUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);
      const contentType = await resolveBufferContentType({ runtime, buffer, fallback: resolveHttpContentType(response.headers), log, accountId });
      const saved = await saveMediaBuffer(buffer, contentType, 'inbound', 30 * 1024 * 1024);
      if (!saved?.path) {
        log(`dingtalk[${accountId}] saveMediaBuffer returned empty path`);
        continue;
      }
      out.push({ path: saved.path, contentType: typeof saved.contentType === 'string' ? saved.contentType : contentType, placeholder: image.placeholder });
    } catch (err) {
      log(`dingtalk[${accountId}] richText image download/save failed: ${String(err)}`);
    }
  }
  return out;
}

type InboundTextParseResult =
  | { text: string; source: 'text' | 'richText'; richTextImages: RichTextImageTask[] }
  | { text: ''; reason: 'unsupported' | 'empty' };

interface RichTextImageTask {
  downloadCode: string;
  placeholder: string;
}

const MAX_RICHTEXT_IMAGES = 10;
const RICHTEXT_IMAGE_PLACEHOLDER = '<media:image>';

interface InboundSavedMedia {
  path: string;
  contentType: string;
  placeholder: string;
}

function parseRichTextNodes(params: { nodes?: DingTalkRichTextNode[] }): { text: string; images: RichTextImageTask[] } {
  const { nodes } = params;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { text: '', images: [] };
  }
  const parts: string[] = [];
  const images: RichTextImageTask[] = [];
  for (const node of nodes) {
    if (typeof node.text === 'string') { parts.push(node.text); continue; }
    if (node.type !== 'picture') continue;
    const downloadCode =
      typeof node.downloadCode === 'string' ? node.downloadCode :
      typeof node.pictureDownloadCode === 'string' ? node.pictureDownloadCode : '';
    if (!downloadCode || images.length >= MAX_RICHTEXT_IMAGES) {
      parts.push('[图片]');
      continue;
    }
    parts.push(RICHTEXT_IMAGE_PLACEHOLDER);
    images.push({ downloadCode, placeholder: RICHTEXT_IMAGE_PLACEHOLDER });
  }
  return { text: parts.join(''), images };
}

async function parseInboundText(params: { payload: DingTalkInboundMessage }): Promise<InboundTextParseResult> {
  const { payload } = params;
  if (payload.msgtype === 'text') {
    const text = (payload.text?.content ?? '').trim();
    return text ? { text, source: 'text', richTextImages: [] } : { text: '', reason: 'empty' };
  }
  if (payload.msgtype === 'richText') {
    const parsedRichText = parseRichTextNodes({ nodes: payload.content?.richText });
    const text = parsedRichText.text.trim();
    return text ? { text, source: 'richText', richTextImages: parsedRichText.images } : { text: '', reason: 'empty' };
  }
  return { text: '', reason: 'unsupported' };
}

async function handleInboundMessage(params: {
  cfg: OpenClawConfig;
  account: ResolvedDingTalkAccount;
  payload: DingTalkInboundMessage;
  log: (message: string) => void;
  error: (message: string) => void;
}): Promise<void> {
  const { cfg, account, payload, log, error } = params;
  const runtime = getRuntime();
  const isGroup = payload.conversationType === '2';

  const parsed = await parseInboundText({ payload });
  if ('reason' in parsed) {
    if (parsed.reason === 'unsupported') {
      log(`dingtalk[${account.accountId}] ignore unsupported msgtype=${payload.msgtype}`);
      return;
    }
    log(`dingtalk[${account.accountId}] ignore empty text`);
    return;
  }
  const messageText = parsed.text;
  const savedMedia = parsed.source === 'richText'
    ? await downloadAndSaveRichTextImages({ runtime, accountId: account.accountId, accessToken: account.accessToken, robotCode: payload.robotCode, images: parsed.richTextImages, log })
    : [];
  const mediaPaths = savedMedia.map((item) => item.path).filter((item) => item.trim().length > 0);
  const mediaTypes = savedMedia.map((item) => item.contentType).filter((item) => item.trim().length > 0);
  const mediaPayload: Record<string, unknown> = {};
  if (mediaPaths.length === 1) {
    mediaPayload.MediaPath = mediaPaths[0];
    if (mediaTypes[0]) mediaPayload.MediaType = mediaTypes[0];
  }
  if (mediaPaths.length > 1) {
    mediaPayload.MediaPaths = mediaPaths;
    if (mediaTypes.length === mediaPaths.length) mediaPayload.MediaTypes = mediaTypes;
  }

  const mentionCandidateIds = Array.from(
    new Set(
      (payload.atUsers ?? []).map((item) => item.dingtalkId?.trim() ?? '').filter((item) => item.length > 0),
    ),
  );
  const mentioned = !isGroup || payload.isInAtList || Boolean(payload.atUsers?.some((item) => item.dingtalkId === payload.chatbotUserId));
  if (isGroup && !mentioned) {
    log(`dingtalk[${account.accountId}] ignore non-mention group message`);
    return;
  }

  if (payload.sessionWebhook) {
    try {
      await sendMarkdownBySessionWebhook({ sessionWebhook: payload.sessionWebhook, secretKey: account.secretKey, text: '💪收到，处理中…' });
    } catch (err) {
      log(`dingtalk[${account.accountId}] immediate ack failed: ${String(err)}`);
    }
  }

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: isGroup ? 'group' : 'direct', id: isGroup ? payload.conversationId : payload.senderId },
  });
  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: 'DingTalk',
    from: isGroup ? `${payload.conversationId}:${payload.senderId}` : payload.senderId,
    timestamp: new Date(payload.createAt || Date.now()),
    envelope: envelopeOptions,
    body: `${payload.senderNick}: ${messageText}`,
  });
  const from = `dingtalk:${payload.senderId}`;
  const to = isGroup ? `chat:${payload.conversationId}` : `user:${payload.senderId}`;
  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body, RawBody: messageText, CommandBody: messageText,
    From: from, To: to,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? 'group' : 'direct',
    GroupSubject: isGroup ? payload.conversationTitle || payload.conversationId : undefined,
    SenderName: payload.senderNick, SenderId: payload.senderId,
    Provider: CHANNEL_ID, Surface: CHANNEL_ID,
    MessageSid: payload.msgId, Timestamp: Date.now(),
    WasMentioned: mentioned, CommandAuthorized: true,
    OriginatingChannel: CHANNEL_ID, OriginatingTo: to,
    ...mediaPayload,
  });

  const prefixContext = createReplyPrefixContext({ cfg, agentId: route.agentId });
  const textChunkLimit = runtime.channel.text.resolveTextChunkLimit(cfg, CHANNEL_ID, account.accountId, { fallbackLimit: 4000 });
  const chunkMode = runtime.channel.text.resolveChunkMode(cfg, CHANNEL_ID);
  const toolProgressMode = isGroup ? account.toolProgressInGroup : account.toolProgress;
  const shouldShowToolProgress = toolProgressMode === 'simple';

  let lastToolName = '';
  let lastToolNoticeAt = 0;
  let toolInFlight = false;
  let toolDoneNoticeSent = false;

  const sendSessionText = async (text: string, options?: { mention?: boolean }): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) return;
    await sendMarkdownBySessionWebhook({
      sessionWebhook: payload.sessionWebhook, secretKey: account.secretKey, text: trimmed,
      mention: options?.mention !== false && mentionCandidateIds.length > 0 ? { atUserIds: mentionCandidateIds } : undefined,
    });
  };

  const sendToolProgressNotice = async (text: string): Promise<void> => {
    if (!shouldShowToolProgress) return;
    await sendSessionText(text, { mention: false });
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    runtime.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: runtime.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
      deliver: async (reply: ReplyPayload, info: { kind?: string }) => {
        const kind = info.kind ?? 'final';
        if (kind === 'tool' && shouldShowToolProgress) {
          if (!toolInFlight) {
            await sendToolProgressNotice('正在处理工具结果...');
            toolInFlight = true;
            toolDoneNoticeSent = false;
            lastToolName = '工具';
            lastToolNoticeAt = Date.now();
          }
          return;
        }
        if ((kind === 'block' || kind === 'final') && shouldShowToolProgress && toolInFlight) {
          if (!toolDoneNoticeSent) {
            await sendToolProgressNotice('工具调用已完成，正在整理答案...');
            toolDoneNoticeSent = true;
          }
          toolInFlight = false;
        }
        const text = (reply.text ?? '').trim();
        if (!text) return;
        const chunks = runtime.channel.text.chunkTextWithMode(text, textChunkLimit, chunkMode);
        for (const chunk of chunks) {
          await sendSessionText(chunk);
        }
      },
      onError: (err: unknown, info: { kind?: string }) => {
        error(`dingtalk[${account.accountId}] ${info.kind} reply failed: ${String(err)}`);
      },
    });

  try {
    await runtime.channel.reply.dispatchReplyFromConfig({
      cfg,
      ctx: ctxPayload,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        disableBlockStreaming: account.blockStreaming === false,
        onToolStart: async (toolPayload: { name?: string; phase?: string }) => {
          if (!shouldShowToolProgress) return;
          const phase = (toolPayload.phase ?? '').trim().toLowerCase();
          if (phase && phase !== 'start' && phase !== 'update') return;
          const rawToolName = (toolPayload.name ?? '').trim();
          const dedupeName = rawToolName || '工具';
          const now = Date.now();
          if (toolInFlight && dedupeName === lastToolName && now - lastToolNoticeAt < TOOL_PROGRESS_THROTTLE_MS) return;
          await sendToolProgressNotice(rawToolName ? `正在调用${rawToolName}...` : '正在调用工具...');
          lastToolName = dedupeName;
          lastToolNoticeAt = now;
          toolInFlight = true;
          toolDoneNoticeSent = false;
        },
      },
    });
    log(`dingtalk[${account.accountId}] dispatched message session=${route.sessionKey}`);
  } finally {
    markDispatchIdle();
  }
}

// ---------------------------------------------------------------------------
// Webhook handler — per-account resolution
// ---------------------------------------------------------------------------

function createWebhookHandler(params: {
  cfg: OpenClawConfig;
  account: ResolvedDingTalkAccount;
  log: (message: string) => void;
  error: (message: string) => void;
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      respondJson(res, 405, { errcode: 1, errmsg: 'Method Not Allowed' });
      return;
    }
    const secretKey = params.account.secretKey;

    // ═══ Authentication ═══
    // Two auth modes are accepted (mirrors original dual-mode design):
    //
    // 1. Standard DingTalk signed-callback: URL has timestamp+sign, verified
    //    with secretKey via HMAC-SHA256. This is the built-in "加签" mode.
    //    Works per-account because the sign is computed with the bot-specific
    //    secretKey — but it requires honmeirin proxy to NOT strip timestamp/sign.
    //
    // 2. Proxy token mode: A `token` HTTP header is present. This is how the
    //    honmeirin reverse proxy forwards DingTalk callbacks — it strips
    //    timestamp+sign from the URL query and injects a `token` header.
    //    When there is only ONE bot, token === secretKey and
    //    `secretKey.startsWith(token)` succeeds.
    //
    //    In multi-account mode, honmeirin uses a single token (the original
    //    bot's secretKey) for all routes under the same honmeirin domain.
    //    For bot2 and beyond, `secretKey.startsWith(token)` FAILS because
    //    the token belongs to bot1, not bot2.
    //
    //    Fix: when a `token` header is present from a trusted proxy (honmeirin),
    //    accept it regardless of whether it matches this account's secretKey.
    //    The honmeirin reverse proxy is the real authentication boundary;
    //    the webhook path already uniquely identifies the account.
    //
    //    If NEITHER mode passes, reject with 401.
    //
    const signOk = verifyDingtalkSign(req, secretKey);
    const token = readTokenHeader(req);
    const tokenOkPrefix = Boolean(token) && secretKey.startsWith(token);
    const tokenOkAny = Boolean(token) && token.length > 0;

    // log full diagnostic info
    const rawUrl = req.url ?? '';
    const hasTimestamp = rawUrl.includes('timestamp=');
    const hasSign = rawUrl.includes('sign=');
    const remoteIp = req.socket.remoteAddress ?? 'unknown';
    params.log?.(
      `dingtalk[${params.account.accountId}] auth check: ` +
      `secretKey=${secretKey.substring(0, 8)}... ` +
      `signOk=${signOk} ` +
      `tokenPrefixOk=${tokenOkPrefix} tokenAnyOk=${tokenOkAny} ` +
      `urlHasTimestamp=${hasTimestamp} urlHasSign=${hasSign} ` +
      `remoteIp=${remoteIp} ` +
      `url=${rawUrl.substring(0, 150)}`
    );

    // Accept if sign is valid (standard DingTalk mode) OR token header is present (proxy mode)
    // In multi-account mode with honmeirin proxy, the token may belong to a different account,
    // but its presence proves the request traversed the trusted honmeirin reverse proxy.
    if (!signOk && !tokenOkAny) {
      params.error?.(
        `dingtalk[${params.account.accountId}] auth rejected: ` +
        `signOk=${signOk} tokenPrefixOk=${tokenOkPrefix} tokenAnyOk=${tokenOkAny} ` +
        `remoteIp=${remoteIp}`
      );
      respondJson(res, 401, { errcode: 1, errmsg: '[dingtalk] invalid token' });
      return;
    }

    try {
      const body = (await readJsonBody(req)) as DingTalkInboundMessage;
      await handleInboundMessage({ cfg: params.cfg, account: params.account, payload: body, log: params.log, error: params.error });
      respondJson(res, 200, { errcode: 0, errmsg: 'ok' });
    } catch (err) {
      params.error(`dingtalk[${params.account.accountId}] inbound error: ${String(err)}`);
      respondJson(res, 500, { errcode: 1, errmsg: 'internal error' });
    }
  };
}

function readTokenHeader(req: IncomingMessage): string {
  const raw = req.headers.token;
  if (Array.isArray(raw)) return raw[0] ?? '';
  return typeof raw === 'string' ? raw : '';
}

// ---------------------------------------------------------------------------
// ChannelPlugin — MULTI-ACCOUNT SUPPORT
// ---------------------------------------------------------------------------

export const dingtalkPlugin: ChannelPlugin = {
  id: CHANNEL_ID,
  meta,
  messaging: {
    normalizeTarget: (raw: string) => normalizeDingTalkTarget(raw),
    targetResolver: {
      hint: DINGTALK_TARGET_HINT,
      looksLikeId: (raw: string, normalized?: string) => looksLikeDingTalkTargetId(raw, normalized),
    },
  },
  capabilities: {
    chatTypes: ['direct', 'group'],
    media: true,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: true,
    blockStreaming: true,
  },
  reload: {
    configPrefixes: ['channels.dingtalk'],
  },
  configSchema: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        secretKey: { type: 'string' },
        accessToken: { type: 'string' },
        webhookPath: { type: 'string' },
        blockStreaming: { type: 'boolean' },
        toolProgress: { type: 'string', enum: ['off', 'simple'] },
        toolProgressInGroup: { type: 'string', enum: ['off', 'simple'] },
        accounts: {
          type: 'object',
          description: '多机器人（多账号）配置。每个 key 是一个账号 ID，value 可覆盖 base 配置。若未指定 secretKey 则继承 base 配置。',
          minProperties: 1,
          additionalProperties: {
            type: 'object',
            additionalProperties: true,
            properties: {
              enabled: { type: 'boolean' },
              secretKey: { type: 'string' },
              accessToken: { type: 'string' },
              webhookPath: { type: 'string' },
              blockStreaming: { type: 'boolean' },
              toolProgress: { type: 'string', enum: ['off', 'simple'] },
              toolProgressInGroup: { type: 'string', enum: ['off', 'simple'] },
            },
          },
        },
      },
      required: ['secretKey'],
    },
  },
  config: {
    /**
     * Return all account IDs for this channel.
     * - "default" is always listed (backwards-compat with single-account config).
     * - Each key under channels.dingtalk.accounts.<name> is also listed.
     */
    listAccountIds: (cfg: OpenClawConfig) => listDingTalkAccountIds(cfg),

    /**
     * Resolve config for a specific account by merging base + account overrides.
     */
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null): ResolvedDingTalkAccount => {
      const base = parseBaseChannelConfig(cfg);
      const resolvedAccountId = normalizeAccountIdForDingtalk(accountId ?? '') || DEFAULT_ACCOUNT_ID;
      return resolveAccountConfig(base, resolvedAccountId);
    },

    defaultAccountId: () => DEFAULT_ACCOUNT_ID,

    isConfigured: (account: ResolvedDingTalkAccount) => Boolean(account.secretKey),

    describeAccount: (account: ResolvedDingTalkAccount) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: Boolean(account.secretKey),
    }),
  },
  outbound: {
    deliveryMode: 'direct',
    chunker: null,
    resolveTarget: ({ to }: { to?: string | null }) => {
      const normalized = normalizeDingTalkTarget(to ?? '');
      return { ok: true, to: normalized || DEFAULT_ACTIVE_OUTBOUND_TARGET };
    },
    sendText: async ({ cfg, to, text, accountId }: { cfg: OpenClawConfig; to: string; text: string; accountId?: string | null }) => {
      const account = dingtalkPlugin.config.resolveAccount(cfg, accountId);
      if (!account.accessToken) {
        throw new Error(OUTBOUND_DISABLED_ERROR);
      }
      await sendMarkdownByRobotAccessToken({ accessToken: account.accessToken, secretKey: account.secretKey, text });
      return { channel: CHANNEL_ID, to, messageId: `dingtalk-${Date.now()}` };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }: { cfg: OpenClawConfig; to: string; text?: string; mediaUrl?: string; accountId?: string | null }) => {
      const account = dingtalkPlugin.config.resolveAccount(cfg, accountId);
      if (!account.accessToken) {
        throw new Error(OUTBOUND_DISABLED_ERROR);
      }
      const outboundText = buildActiveOutboundText({ text, mediaUrl });
      await sendMarkdownByRobotAccessToken({ accessToken: account.accessToken, secretKey: account.secretKey, text: outboundText });
      return { channel: CHANNEL_ID, to, messageId: `dingtalk-${Date.now()}` };
    },
  },
  gateway: {
    startAccount: async (ctx: {
      cfg: OpenClawConfig;
      accountId: string;
      abortSignal?: AbortSignal;
      log?: { info?: (message: string) => void; error?: (message: string) => void };
    }) => {
      const account = resolveAccountConfig(parseBaseChannelConfig(ctx.cfg), ctx.accountId);

      if (!account.secretKey) {
        const msg = `[dingtalk] account "${ctx.accountId}" has no secretKey (neither base nor override). Skipping.`;
        ctx.log?.error?.(msg);
        // Don't throw — a misconfigured account shouldn't kill the whole channel
        return Promise.resolve();
      }

      // Check if this account is disabled (either base or account-level)
      if (!account.enabled) {
        ctx.log?.info?.(`dingtalk[${ctx.accountId}] account explicitly disabled, skipping webhook registration`);
        const abortSignal = ctx.abortSignal;
        if (!abortSignal) return Promise.resolve();
        return new Promise<void>((resolve) => { abortSignal.addEventListener('abort', () => resolve(), { once: true }); });
      }

      const webhookPath = account.webhookPath;

      // Teardown previous route if this account is being restarted (reload)
      const prevUnregister = routeUnregisterByAccount.get(account.accountId);
      if (prevUnregister) {
        prevUnregister();
        routeUnregisterByAccount.delete(account.accountId);
      }

      // Register the HTTP route for this account
      const unregister = registerPluginHttpRoute({
        path: webhookPath,
        handler: createWebhookHandler({ cfg: ctx.cfg, account, log: (m) => ctx.log?.info?.(m), error: (m) => ctx.log?.error?.(m) }),
        pluginId: CHANNEL_ID,
        source: 'channel',
        accountId: account.accountId,
        log: (message: string) => ctx.log?.info?.(message),
      });

      routeUnregisterByAccount.set(account.accountId, unregister);
      ctx.log?.info?.(`dingtalk[${account.accountId}] webhook route registered: ${webhookPath}`);

      if (account.accessToken) {
        ctx.log?.info?.(`dingtalk[${account.accountId}] active outbound enabled (robot/send by accessToken)`);
      } else {
        ctx.log?.info?.(`dingtalk[${account.accountId}] active outbound disabled (no accessToken) — "Outbound not configured" may appear`);
      }

      // Keep the channel alive via abort signal (same pattern as before)
      if (ctx.abortSignal && ctx.abortSignal.aborted) return;
      return new Promise<void>((resolve) => {
        if (!ctx.abortSignal) return resolve();
        ctx.abortSignal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
    stopAccount: async (ctx: { accountId: string; log?: { info?: (message: string) => void } }) => {
      const unregister = routeUnregisterByAccount.get(ctx.accountId);
      if (unregister) {
        unregister();
        routeUnregisterByAccount.delete(ctx.accountId);
      }
      ctx.log?.info?.(`dingtalk[${ctx.accountId}] stopped`);
    },
  },
};