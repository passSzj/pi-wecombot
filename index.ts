/**
 * pi-wecombot
 *
 * 企业微信智能机器人 WebSocket 长连接扩展 for pi
 * 支持多个机器人配置和快速切换
 *
 * 参考: https://developer.work.weixin.qq.com/document/path/101463
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { WSClient, generateReqId, decryptFile } from "@wecom/aibot-node-sdk";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ============================================================================
// Logger Helper
// ============================================================================

function now(): string {
  return new Date().toISOString();
}

function log(message?: any, ...optionalParams: any[]) {
  if (typeof message === "string" && message.startsWith("[wecombot]")) {
    console.log(`[${now()}] ${message}`, ...optionalParams);
  } else {
    console.log(`[${now()}] [wecombot]`, message, ...optionalParams);
  }
}

function logError(message?: any, ...optionalParams: any[]) {
  if (typeof message === "string" && message.startsWith("[wecombot]")) {
    console.error(`[${now()}] ${message}`, ...optionalParams);
  } else {
    console.error(`[${now()}] [wecombot]`, message, ...optionalParams);
  }
}

function logWarn(message?: any, ...optionalParams: any[]) {
  if (typeof message === "string" && message.startsWith("[wecombot]")) {
    console.warn(`[${now()}] ${message}`, ...optionalParams);
  } else {
    console.warn(`[${now()}] [wecombot]`, message, ...optionalParams);
  }
}

// ============================================================================
// Global Error Handlers
// ============================================================================

// 防止未捕获的 promise rejection 导致进程崩溃
process.on("unhandledRejection", (reason) => {
  // 忽略流已过期错误
  if (reason && typeof reason === "object") {
    const err = reason as any;
    if (err.errcode === 846608 || err.message?.includes("expired") || err.message?.includes("stream message update expired")) {
      log("[wecombot] 忽略流过期错误");
      return;
    }
  }
  logError("[wecombot] 未捕获的 promise rejection:", reason);
});

// ============================================================================
// Config
// ============================================================================

interface BotConfig {
  botId: string;
  secret: string;
  name?: string;
}

// 全局配置：所有会话共享机器人列表
interface GlobalConfig {
  bots: BotConfig[];
  piWebUrl?: string; // 可选的 pi-web 服务地址（默认 http://127.0.0.1:30141）
}

// 会话配置：每个会话独立选择启用哪个机器人
interface SessionConfig {
  activeBotId?: string;  // 当前会话启用的机器人
  enabled?: boolean;     // 当前会话是否启用
}

interface Session {
  frame: any;
  streamId: string;
  userId: string;
  chatId: string;
  timestamp: number;
  botId: string;
}

// ============================================================================
// Session Utils
// ============================================================================

// 解析会话唯一标识：env 显式覆盖 > pi 会话 ID（跨重启稳定）> 随机兜底
// 注：纯随机 ID 会导致会话重启后读不到旧配置，机器人无法自动重连
function resolveSessionId(ctx?: ExtensionContext): string {
  if (process.env.PI_SESSION_ID) return process.env.PI_SESSION_ID;
  if (process.env.PI_INSTANCE_ID) return process.env.PI_INSTANCE_ID;
  try {
    if (ctx?.sessionManager?.getSessionId) return ctx.sessionManager.getSessionId();
  } catch { /* fallthrough */ }
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6);
  return `sess-${timestamp}-${random}`;
}

// 获取全局配置路径（机器人列表，所有会话共享）
function getGlobalConfigPath(): string {
  return join(homedir(), ".pi", "agent", "wecom-bot.json");
}

// 获取会话专属配置路径（会话选择哪个机器人，会话独立）
function getSessionConfigPath(sessionId: string): string {
  return join(homedir(), ".pi", "agent", `wecom-bot-session-${sessionId}.json`);
}

// 获取会话专属临时目录
function getSessionTempPath(sessionId: string): string {
  return join(homedir(), ".pi", "agent", "tmp", "wecom-bot", sessionId);
}

// 全局变量
let GLOBAL_CONFIG: string;

const PROMPT = `
[wecom-bot] 企业微信机器人已连接
- 收到 @机器人 的消息会自动处理
- 你的回复会自动发送到对应用户的企业微信，直接输出正文即可，无需调用 wecombot-send
- 使用 wecombot-attach 发送文件`;

// ============================================================================
// Config Management
// ============================================================================

// 加载全局配置（机器人列表）
async function loadGlobalConfig(): Promise<GlobalConfig> {
  try {
    const data = JSON.parse(await readFile(GLOBAL_CONFIG, "utf8"));
    return { bots: data.bots || [], piWebUrl: data.piWebUrl };
  } catch {
    return { bots: [] };
  }
}

// 保存全局配置（机器人列表）
async function saveGlobalConfig(c: GlobalConfig) {
  await mkdir(dirname(GLOBAL_CONFIG), { recursive: true });
  await writeFile(GLOBAL_CONFIG, JSON.stringify(c, null, "\t") + "\n");
}

// 保存指定会话的配置（用于新开会话继承机器人）
async function saveSessionConfigForId(sessionId: string, c: SessionConfig) {
  const cfgPath = getSessionConfigPath(sessionId);
  await mkdir(dirname(cfgPath), { recursive: true });
  await writeFile(cfgPath, JSON.stringify(c, null, "\t") + "\n");
}

// 获取 pi-web 访问地址
function getPiWebUrl(globalCfg?: GlobalConfig): string {
  if (globalCfg?.piWebUrl) return globalCfg.piWebUrl.replace(/\/+$/, "");
  if (process.env.PI_WEB_URL) return process.env.PI_WEB_URL.replace(/\/+$/, "");
  const port = process.env.PI_WEB_PORT || process.env.PORT || "30141";
  return `http://127.0.0.1:${port}`;
}

// 获取请求 pi-web API 所需的请求头（包括 Basic Auth 如果设置了密码）
function getPiWebHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const password = process.env.PI_WEB_PASSWORD;
  if (password) {
    headers["Authorization"] = `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`;
  }
  return headers;
}

function getActiveBot(bots: BotConfig[], activeBotId?: string): BotConfig | undefined {
  return bots.find(b => b.botId === activeBotId) || bots[0];
}

function getBotById(bots: BotConfig[], botId: string): BotConfig | undefined {
  return bots.find(b => b.botId === botId);
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
  // 初始化路径（会话身份依赖 ctx，延迟到 session_start 解析）
  GLOBAL_CONFIG = getGlobalConfigPath();

  log(`[wecombot] 全局配置: ${GLOBAL_CONFIG}`);

  // 会话私有身份与路径（实例隔离，严防多会话互相覆盖）
  let sessionId = "";
  let sessionConfigPath = "";
  let tempDir = "";
  let isManualDisconnect = false;

  // 加载本会话配置（会话选择的机器人和启用状态）
  async function loadSessionConfig(): Promise<SessionConfig> {
    if (!sessionConfigPath) return { enabled: true };
    try {
      const data = JSON.parse(await readFile(sessionConfigPath, "utf8"));
      return { activeBotId: data.activeBotId, enabled: data.enabled ?? true };
    } catch {
      return { enabled: true };
    }
  }

  // 保存本会话配置
  async function saveSessionConfig(c: SessionConfig) {
    if (!sessionConfigPath) return;
    await mkdir(dirname(sessionConfigPath), { recursive: true });
    await writeFile(sessionConfigPath, JSON.stringify(c, null, "\t") + "\n");
  }

  // 获取本会话专属临时目录
  function getTempDir(): string {
    if (!tempDir) {
      tempDir = getSessionTempPath(sessionId || "default");
    }
    return tempDir;
  }

  // 全局机器人列表（从全局配置加载）
  let globalBots: BotConfig[] = [];
  // 会话配置（本会话选择哪个机器人）
  let sessionCfg: SessionConfig = { enabled: true };

  let ws: WSClient | null = null;
  let connected = false;

  // 暴露状态给外部（用于条件注册工具）
  const isWecomConnected = () => ws !== null && connected;
  let toolsRegistered = false;
  // 保存当前会话的 ctx，用于 WebSocket 回调
  let currentCtx: ExtensionContext | null = null;

  const sessions = new Map<string, Session>();

  // 待处理消息项
  interface PendingMessage {
    reqId: string;
    type: string;
    text: string;
    timestamp: number;
    conversationId: string;
  }

  // 待处理消息队列，每条消息关联 reqId
  const pendingMessages: PendingMessage[] = [];
  let isProcessing = false;
  let currentReqId: string | null = null;  // 当前正在处理的 reqId
  let hasSentViaTool = false;              // 当前请求是否已通过工具（如 wecombot-send）发送了回复

  // 消息进度跟踪（持续通知）
  const messageTimeouts = new Map<string, NodeJS.Timeout>();

  // 持续进度通知时间点：5分钟、15分钟、30分钟、1小时
  const PROGRESS_NOTIFY_POINTS = [
    { delay: 5 * 60 * 1000, message: "⏳ 正在处理中，请稍候..." },
    { delay: 8 * 60 * 1000, message: "⏳ 处理时间较长，请继续等待..." },
    { delay: 9 * 60 * 1000, message: "⚠️ 即将超时，请尽快回复" },
  ];
  const PROGRESS_NOTIFY_INTERVAL = 30 * 1000; // 每30秒检查一次进度通知

  // 记录已发送的通知时间点（避免重复发送）
  const notifiedPoints = new Map<string, Set<number>>();

  // 获取会话标识
  function getConversationId(session: Session): string {
    return session.chatId || session.userId;
  }

  // 【增强】获取队列位置信息
  function getQueuePosition(conversationId: string): { total: number; position: number; ahead: number } {
    let position = 0;
    let ahead = 0;
    for (let i = 0; i < pendingMessages.length; i++) {
      if (pendingMessages[i].conversationId === conversationId) {
        position = i + 1;
        break;
      }
      ahead++;
    }
    return { total: pendingMessages.length, position, ahead };
  }

  // 【增强】发送处理进度通知（持续通知）
  async function sendProgressNotification(
    reqId: string,
    session: Session,
    elapsedMs: number
  ): Promise<void> {
    if (currentReqId !== reqId) return;

    if (!notifiedPoints.has(reqId)) {
      notifiedPoints.set(reqId, new Set());
    }
    const sent = notifiedPoints.get(reqId)!;

    // 企业微信限制：超过 10 分钟无法回复，跳过超时后的通知
    const STREAM_TIMEOUT_MS = 10 * 60 * 1000;

    for (const point of PROGRESS_NOTIFY_POINTS) {
      // 跳过超过 10 分钟的通知点
      if (point.delay > STREAM_TIMEOUT_MS) {
        if (!sent.has(point.delay) && elapsedMs >= point.delay) {
          sent.add(point.delay);

        }
        continue;
      }

      if (!sent.has(point.delay) && elapsedMs >= point.delay) {
        sent.add(point.delay);
        // 必须 isEnd=true，否则草稿状态锁定会话导致最终回复无效
        ws?.replyStream(session.frame, session.streamId, point.message, true).catch((err: any) => {
          // 忽略超时错误
          if (err?.errcode !== 846608) {
            logError(`[wecombot] 进度通知失败:`, err);
          }
        });
        // 结束该流后为该会话生成新的 streamId，避免后续消息复用已结束的流
        session.streamId = generateReqId("stream");
        break;
      }
    }
  }

  // 【增强】启动持续进度通知检查
  function startProgressNotifier(reqId: string, session: Session, startTime: number) {
    const checkInterval = setInterval(() => {
      if (currentReqId !== reqId) {
        clearInterval(checkInterval);
        notifiedPoints.delete(reqId);
        return;
      }

      const elapsed = Date.now() - startTime;
      sendProgressNotification(reqId, session, elapsed);

      const sent = notifiedPoints.get(reqId);
      if (sent && sent.size >= PROGRESS_NOTIFY_POINTS.length) {
        clearInterval(checkInterval);
      }
    }, PROGRESS_NOTIFY_INTERVAL);

    messageTimeouts.set(reqId + '_progress', checkInterval);
  }

  // 【增强】清理进度通知定时器
  function clearProgressNotifier(reqId: string) {
    const interval = messageTimeouts.get(reqId + '_progress');
    if (interval) {
      clearInterval(interval);
      messageTimeouts.delete(reqId + '_progress');
    }
    notifiedPoints.delete(reqId);
  }

  // 处理消息队列
  async function processMessageQueue() {
    if (isProcessing || pendingMessages.length === 0) return;
    isProcessing = true;

    // 取出队首消息（不删除，等 AI 回复后再删除）
    const message = pendingMessages[0];
    if (!message) {
      isProcessing = false;
      return;
    }

    // 检查会话是否还存在
    if (!sessions.has(message.reqId)) {
      // 会话已过期，移除并处理下一条
      log(`[wecombot] 会话 ${message.reqId.slice(0, 8)} 已过期，跳过`);
      pendingMessages.shift();
      isProcessing = false;
      processMessageQueue();
      return;
    }

    currentReqId = message.reqId;
    hasSentViaTool = false;

    // 【增强】启动持续进度通知
    const session = sessions.get(message.reqId);
    if (session) {
      startProgressNotifier(message.reqId, session, Date.now());
    }

    try {
      await pi.sendUserMessage([{ type: "text", text: message.text }], { deliverAs: "steer" });
      log(`[wecombot] 消息已发送: reqId=${message.reqId.slice(0, 8)}, 队列剩余=${pendingMessages.length - 1}`);
    } catch (err: any) {
      if (err?.message?.includes('already processing')) {
        log('[wecombot] Agent 忙，消息将在 500ms 后重试');
        currentReqId = null;
        hasSentViaTool = false;
      } else {
        logError('[wecombot] 发送消息失败:', err);
        pendingMessages.shift();  // 移除失败消息
        currentReqId = null;
        hasSentViaTool = false;
      }
    }

    isProcessing = false;

    // 如果没有错误，等待 agent_end 后再处理下一条
    if (currentReqId === null && pendingMessages.length > 0) {
      setTimeout(processMessageQueue, 500);
    }
  }

  // 发送消息到队列（关联 reqId）
  function queueMessage(reqId: string, text: string, session: Session) {
    const conversationId = getConversationId(session);
    const queueLength = pendingMessages.length;

    // 【增强】发送队列位置反馈
    if (queueLength > 0) {
      // 队列中有其他消息，告知用户排队位置
      replyTo(reqId, `👋 收到，你是第 ${queueLength + 1} 位，前面还有 ${queueLength} 条消息...`, false);
    }

    pendingMessages.push({ reqId, type: "text", text, timestamp: Date.now(), conversationId });
    processMessageQueue();
  }

  // 清理过期会话
  setInterval(() => {
    const now = Date.now();
    for (const [reqId, session] of sessions) {
      if (now - session.timestamp > 60 * 60 * 1000) {
        sessions.delete(reqId);
      }
    }
  }, 60000);

  // Status - 已连接后才显示，未连接时不显示
  function setStatus(ctx: ExtensionContext | null, msg?: string) {
    // ctx 可能已失效（session 已替换），捕获此错误避免崩溃
    try {
      const active = getActiveBot(globalBots, sessionCfg.activeBotId);

      // 已连接或有提示时显示状态栏
      if (!ctx) return;
      if (!connected && !msg) {
        ctx.ui.setStatus("wecombot", "");
        return;
      }

      const botName = active?.name || active?.botId.slice(0, 8) || "企微";

      if (msg) {
        // 有错误信息时显示
        ctx.ui.setStatus("wecombot", `${botName}【wecom】🔴 ${msg}`);
      } else {
        // 已连接
        ctx.ui.setStatus("wecombot", `${botName}【wecom】✅ ${sessions.size}`);
      }
    } catch (err: any) {
      // 忽略 ctx 已失效错误（正常现象，session 替换时旧回调会触发）
      if (err?.message?.includes("stale")) {
        log("[wecombot] setStatus: ctx 已失效，忽略");
        return;
      }
      throw err;
    }
  }

  // 回复
  function replyTo(reqId: string, content: string, isEnd = true): Promise<any> {
    if (!ws || !connected) {
      log(`[wecombot] 回复失败: ws未连接, reqId=${reqId.slice(0, 8)}`);
      return Promise.resolve();
    }
    const session = sessions.get(reqId);
    if (!session) {
      log(`[wecombot] 回复失败: 会话不存在, reqId=${reqId.slice(0, 8)}, 当前sessions=${sessions.size}`);
      return Promise.resolve();
    }
    const p = ws.replyStream(session.frame, session.streamId, content, isEnd).catch((err: any) => {
      // 忽略流已过期错误（正常情况，10分钟后自动触发）
      if (err?.errcode === 846608 || err?.message?.includes('expired')) {
        log(`[wecombot] 流已过期: reqId=${reqId.slice(0, 8)}`);
      } else {
        logError(`[wecombot] 回复异常: reqId=${reqId.slice(0, 8)}`, err);
      }
    });
    // 当流式消息结束时，为该会话生成新的 streamId，确保后续消息不会覆盖已结束的气泡
    if (isEnd) {
      session.streamId = generateReqId("stream");
    }
    return p;
  }

  // 解析是否包含新会话重置指令
  function parseCommandText(text: string): { isNew: boolean; args?: string } {
    const cleaned = text.trim().replace(/^@\S+\s*/, "").trim();
    if (cleaned === "/new" || cleaned === "/clear" || cleaned === "/reset") {
      return { isNew: true };
    }
    if (cleaned.startsWith("/new ") || cleaned.startsWith("/clear ") || cleaned.startsWith("/reset ")) {
      const spaceIndex = cleaned.indexOf(" ");
      return { isNew: true, args: cleaned.slice(spaceIndex + 1).trim() };
    }
    return { isNew: false };
  }

  // 后备创建新会话（直接写 session 文件并使 pi-web 缓存失效）
  async function createFallbackSession(cwd: string): Promise<string | null> {
    try {
      const timestamp = new Date().toISOString();
      const newSessionId = randomUUID();
      const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
      const sessionDir = join(homedir(), ".pi", "agent", "sessions", safePath);
      await mkdir(sessionDir, { recursive: true });

      const fileTimestamp = timestamp.replace(/[:.]/g, "-");
      const sessionFile = join(sessionDir, `${fileTimestamp}_${newSessionId}.jsonl`);

      const header = {
        type: "session",
        version: 3,
        id: newSessionId,
        timestamp,
        cwd,
      };
      await writeFile(sessionFile, JSON.stringify(header) + "\n");
      log(`[wecombot] 后备模式: 已直接创建 session 文件 ${sessionFile}`);

      // 通知内存中的 pi-web 缓存失效
      if (typeof (globalThis as any).__piSessionListGeneration === "number") {
        (globalThis as any).__piSessionListGeneration += 1;
        (globalThis as any).__piSessionListCache = undefined;
      }
      return newSessionId;
    } catch (err) {
      logError(`[wecombot] 后备创建 session 失败:`, err);
      return null;
    }
  }

  // 触发新会话加载并接管连接
  async function triggerSessionReload(newSessionId: string, piWebUrl: string) {
    // 方式 A：进程内直接调用已注册的 AgentSessionWrapper
    const inMemoryWrapper = (globalThis as any).__piSessions?.get(newSessionId);
    if (inMemoryWrapper && typeof inMemoryWrapper.send === "function") {
      log(`[wecombot] 正在通过进程内 AgentSessionWrapper 触发新会话 reload: ${newSessionId.slice(0, 8)}`);
      try {
        await inMemoryWrapper.send({ type: "reload" });
        log(`[wecombot] 进程内 reload 触发成功`);
        return;
      } catch (err) {
        logWarn(`[wecombot] 进程内 reload 异常，尝试 HTTP API:`, err);
      }
    }

    // 方式 B：通过 HTTP 接口触发
    try {
      log(`[wecombot] 正在通过 HTTP POST /api/agent/${newSessionId.slice(0, 8)} 触发 reload`);
      const res = await fetch(`${piWebUrl}/api/agent/${encodeURIComponent(newSessionId)}`, {
        method: "POST",
        headers: getPiWebHeaders(),
        body: JSON.stringify({ type: "reload" }),
      });
      if (res.ok) {
        log(`[wecombot] HTTP reload 触发成功`);
      } else {
        logWarn(`[wecombot] HTTP reload 返回状态码: ${res.status}`);
      }
    } catch (err: any) {
      logWarn(`[wecombot] HTTP reload 请求异常:`, err?.message || err);
    }
  }

  // 处理新会话切换逻辑
  async function handleNewSessionCommand(
    reqId: string,
    session: Session,
    bot: BotConfig,
    initialPrompt?: string
  ) {
    try {
      log(`[wecombot] 收到新会话重置指令，开始创建并切换新会话...`);

      // 1. 中断旧会话可能正在运行的任务并清空队列
      if (currentCtx) {
        try { currentCtx.abort(); } catch {}
      }
      clearProgressNotifier(currentReqId || "");
      pendingMessages.length = 0;
      currentReqId = null;
      isProcessing = false;
      hasSentViaTool = false;

      // 2. 发送过渡反馈
      if (session.frame) {
        await replyTo(reqId, "🔄 正在创建并切换至新会话...", false);
      }

      const currentBotId = sessionCfg.activeBotId || bot.botId;
      const cwd = currentCtx?.cwd || process.cwd();
      const globalCfg = await loadGlobalConfig();
      const piWebUrl = getPiWebUrl(globalCfg);

      let newSessionId: string | null = null;

      // 3. 优先通过 pi-web 创建新 session
      try {
        log(`[wecombot] 请求 pi-web 创建新会话: ${piWebUrl}/api/agent/new, cwd=${cwd}`);
        const res = await fetch(`${piWebUrl}/api/agent/new`, {
          method: "POST",
          headers: getPiWebHeaders(),
          body: JSON.stringify({
            cwd,
            type: "ensure_session",
            ...(currentCtx?.model ? {
              provider: currentCtx.model.provider,
              modelId: currentCtx.model.id,
            } : {}),
            ...((currentCtx as any)?.thinkingLevel ? {
              thinkingLevel: (currentCtx as any).thinkingLevel,
            } : {}),
          }),
        });

        if (res.ok) {
          const data = (await res.json()) as any;
          if (data?.success && data?.sessionId) {
            newSessionId = data.sessionId;
            log(`[wecombot] pi-web 创建新会话成功: ${newSessionId?.slice(0, 8)}`);
          }
        } else {
          logWarn(`[wecombot] pi-web /api/agent/new 响应状态码 ${res.status}: ${await res.text()}`);
        }
      } catch (err: any) {
        logWarn(`[wecombot] 请求 pi-web /api/agent/new 异常:`, err?.message || err);
      }

      // 4. 若无法连接 pi-web，则采用本地创建 session 文件的后备方案
      if (!newSessionId) {
        newSessionId = await createFallbackSession(cwd);
      }

      if (!newSessionId) {
        throw new Error("创建新会话失败，无法生成新会话");
      }

      // 5. 将当前机器人的活跃配置写入新会话
      await saveSessionConfigForId(newSessionId, {
        activeBotId: currentBotId,
        enabled: true,
      });
      log(`[wecombot] 新会话配置已写入: ${newSessionId.slice(0, 8)}`);

      // 6. 给企微用户发送成功通知并结束气泡
      if (session.frame) {
        await replyTo(reqId, "✅ 已开启新会话，开始新的对话吧！", true);
        // 等待 300ms 保证 WebSocket 消息帧发送完毕
        await new Promise((r) => setTimeout(r, 300));
      }

      // 7. 禁用本会话并断开本会话连接，释放 BotID 长连
      sessionCfg.enabled = false;
      await saveSessionConfig(sessionCfg);
      disconnect();
      setStatus(currentCtx, "已切换到新会话");

      // 等待 500ms 确保旧长连在网关完全断开释放，避免与新会话连接产生竞争
      await new Promise((r) => setTimeout(r, 500));

      // 8. 触发新会话 reload 以接管机器人连接
      await triggerSessionReload(newSessionId, piWebUrl);

      // 9. 如果用户在 /new 后附带了文本（例如 `/new 请帮我分析...`），延迟发送到新会话
      if (initialPrompt && initialPrompt.trim()) {
        setTimeout(async () => {
          try {
            await fetch(`${piWebUrl}/api/agent/${encodeURIComponent(newSessionId!)}`, {
              method: "POST",
              headers: getPiWebHeaders(),
              body: JSON.stringify({
                type: "prompt",
                message: `[wecombot] [${bot.name || bot.botId}] [${session.userId}]\n${initialPrompt.trim()}`,
              }),
            });
          } catch (e) {
            logError(`[wecombot] 发送初始消息异常:`, e);
          }
        }, 1500);
      }

    } catch (err: any) {
      logError(`[wecombot] 切换新会话失败:`, err);
      if (session.frame) {
        replyTo(reqId, `❌ 切换新会话失败: ${err?.message || String(err)}`, true);
      }
    }
  }

  // 连接 - 添加错误保护
  async function connect(ctx: ExtensionContext, bot: BotConfig): Promise<boolean> {
    try {
      disconnect();
      isManualDisconnect = false;

      log(`[wecombot] 连接中: ${bot.name || bot.botId}`);
      log(`[wecombot] ⚠️ 提示: 同一机器人只能有一个连接，其他会话将被断开`);

      ws = new WSClient({
        botId: bot.botId,
        secret: bot.secret,
        reconnectInterval: 2000,
        maxReconnectAttempts: -1, // 无限重连，断线后持续退避重连
        maxAuthFailureAttempts: 5, // 认证失败重试5次
        heartbeatInterval: 20000, // 20秒心跳保活，避免网关超时断开
        logger: {
          debug: () => {},
          info: (msg, ...args) => log(`[AiBotSDK] [INFO] ${msg}`, ...args),
          warn: (msg, ...args) => logWarn(`[AiBotSDK] [WARN] ${msg}`, ...args),
          error: (msg, ...args) => logError(`[AiBotSDK] [ERROR] ${msg}`, ...args),
        },
      });

      ws.on("connected", () => {
        log(`[wecombot] ✅ ${bot.name || bot.botId} 已连接`);
        connected = true;
        setStatus(currentCtx);
      });

      ws.on("reconnecting", (attempt: number) => {
        log(`[wecombot] 🔄 ${bot.name || bot.botId} 正在尝试重连 (第 ${attempt} 次)...`);
        connected = false;
        setStatus(currentCtx, `重连中(${attempt})`);
      });

      ws.on("authenticated", () => {
        log(`[wecombot] ✅ ${bot.name || bot.botId} 认证成功`);
        connected = true;
        setStatus(currentCtx);
        if (!toolsRegistered) {
          registerTools();
          toolsRegistered = true;
        }
      });

      ws.on("message.text", async (frame: any) => {
        const content = frame.body?.text?.content || "";
        if (!content) return;

        const reqId = frame.headers?.req_id || generateReqId("msg");
        const userId = frame.body?.from?.userid || "unknown";
        const chatId = frame.body?.chatid || "";
        const botId = bot.botId;
        const botName = bot.name;

        log(`[wecombot] [${botName || botId}] [${userId}] ${content.slice(0, 30)}`);

        const session: Session = { frame, streamId: generateReqId("stream"), userId, chatId, timestamp: Date.now(), botId };
        sessions.set(reqId, session);

        // 拦截是否为新会话重置指令 (/new, /clear, /reset)
        const cmd = parseCommandText(content);
        if (cmd.isNew) {
          await handleNewSessionCommand(reqId, session, bot, cmd.args);
          return;
        }

        replyTo(reqId, "🤔 思考中...", false);
        // 消息关联 reqId 入队，传入 session
        queueMessage(reqId, `[wecombot] [${botName || botId}] [${userId}]\n${content}`, session);
      });

      ws.on("message.image", async (frame: any) => {
        const url = frame.body?.image?.url;
        const aesKey = frame.body?.image?.aeskey;
        const reqId = frame.headers?.req_id || generateReqId("msg");
        if (url) {
          const userId = frame.body?.from?.userid || "unknown";
          const session: Session = { frame, streamId: generateReqId("stream"), userId, chatId: frame.body?.chatid || "", timestamp: Date.now(), botId: bot.botId };
          sessions.set(reqId, session);
          replyTo(reqId, "🤔 思考中...", false);

          // 下载并解密图片
          try {
            if (!ws) throw new Error("WS未连接"); const { buffer } = await ws.downloadFile(url, aesKey);
            const base64Image = buffer.toString('base64');
            // 保存到临时目录
            const filename = `img_${Date.now()}.jpg`;
            const filepath = join(getTempDir(), filename);
            await writeFile(filepath, buffer);
            log(`[wecombot] 图片已保存: ${filepath}`);
            queueMessage(reqId, `[wecombot] [${bot.name || bot.botId}] [${userId}] 发送了图片: ${filepath}
[base64图片: data:image/jpeg;base64,${base64Image.substring(0, 100)}...]`, session);
          } catch (err) {
            logError(`[wecombot] 图片下载失败:`, err);
            queueMessage(reqId, `[wecombot] [${bot.name || bot.botId}] [${userId}] 发送了图片（下载失败）: ${url}`, session);
          }
        }
      });

      ws.on("message.mixed", async (frame: any) => {
        const msgItems = frame.body?.mixed?.msg_item;
        const reqId = frame.headers?.req_id || generateReqId("msg");
        if (!Array.isArray(msgItems) || msgItems.length === 0) return;


        const userId = frame.body?.from?.userid || "unknown";
        const session: Session = { frame, streamId: generateReqId("stream"), userId, chatId: frame.body?.chatid || "", timestamp: Date.now(), botId: bot.botId };
        sessions.set(reqId, session);

        // 解析图文混排内容
        let textParts: string[] = [];
        let imageInfos: { url: string; aeskey?: string }[] = [];

        for (const item of msgItems) {
          if (item.msgtype === "text" && item.text?.content) {
            textParts.push(item.text.content);
          } else if (item.msgtype === "image" && item.image?.url) {
            imageInfos.push({ url: item.image.url, aeskey: item.image.aeskey });
          }
        }

        const contentText = textParts.join(" ");

        // 下载图片
        let imageText = "";
        if (imageInfos.length > 0 && ws) {
          for (const img of imageInfos) {
            try {
              const { buffer } = await ws.downloadFile(img.url, img.aeskey);
              const filename = `img_${Date.now()}.jpg`;
              const filepath = join(getTempDir(), filename);
              await writeFile(filepath, buffer);
              log(`[wecombot] mixed图片已保存: ${filepath}`);
              imageText += `
[图片: ${filepath}]`;
            } catch (err) {
              logError(`[wecombot] mixed图片下载失败:`, err);
              imageText += `
[图片（下载失败）: ${img.url}]`;
            }
          }
        } else if (imageInfos.length > 0) {
          imageText = `
[图片: ${imageInfos.map(i => i.url).join(", ")}]`;
        }

        if (contentText || imageText) {
          replyTo(reqId, "🤔 思考中...", false);
          queueMessage(reqId, `[wecombot] [${bot.name || bot.botId}] [${userId}]
${contentText}${imageText}`, session);
        }
      });

      ws.on("message.voice", (frame: any) => {
        const content = frame.body?.voice?.content;
        const reqId = frame.headers?.req_id || generateReqId("msg");
        if (content) {
          const userId = frame.body?.from?.userid || "unknown";
          const session: Session = { frame, streamId: generateReqId("stream"), userId, chatId: frame.body?.chatid || "", timestamp: Date.now(), botId: bot.botId };
          sessions.set(reqId, session);
          replyTo(reqId, "🤔 思考中...", false);
          queueMessage(reqId, `[wecombot] [${bot.name || bot.botId}] [${userId}]\n${content}`, session);
        }
      });

      ws.on("message.file", async (frame: any) => {
        const url = frame.body?.file?.url;
        const filename = frame.body?.file?.filename || "文件";
        const aesKey = frame.body?.file?.aeskey;
        const reqId = frame.headers?.req_id || generateReqId("msg");
        if (url) {
          const userId = frame.body?.from?.userid || "unknown";
          const session: Session = { frame, streamId: generateReqId("stream"), userId, chatId: frame.body?.chatid || "", timestamp: Date.now(), botId: bot.botId };
          sessions.set(reqId, session);
          replyTo(reqId, "🤔 思考中...", false);

          // 下载并解密文件
          try {
            if (!ws) throw new Error("WS未连接");
            const { buffer, filename: downloadedFilename } = await ws.downloadFile(url, aesKey);
            const savedFilename = downloadedFilename || filename;
            const filepath = join(getTempDir(), `file_${Date.now()}_${savedFilename}`);
            await writeFile(filepath, buffer);
            log(`[wecombot] 文件已保存: ${filepath}`);
            queueMessage(reqId, `[wecombot] [${bot.name || bot.botId}] [${userId}] 发送了文件「${savedFilename}」: ${filepath}`, session);
          } catch (err) {
            logError(`[wecombot] 文件下载失败:`, err);
            queueMessage(reqId, `[wecombot] [${bot.name || bot.botId}] [${userId}] 发送了文件「${filename}」（下载失败）: ${url}`, session);
          }
        }
      });

      ws.on("message.video", async (frame: any) => {
        const url = frame.body?.video?.url;
        const aesKey = frame.body?.video?.aeskey;
        const reqId = frame.headers?.req_id || generateReqId("msg");
        if (url) {
          const userId = frame.body?.from?.userid || "unknown";
          const session: Session = { frame, streamId: generateReqId("stream"), userId, chatId: frame.body?.chatid || "", timestamp: Date.now(), botId: bot.botId };
          sessions.set(reqId, session);
          replyTo(reqId, "🤔 思考中...", false);

          // 下载并解密视频
          try {
            if (!ws) throw new Error("WS未连接");
            const { buffer } = await ws.downloadFile(url, aesKey);
            const filepath = join(getTempDir(), `video_${Date.now()}.mp4`);
            await writeFile(filepath, buffer);
            log(`[wecombot] 视频已保存: ${filepath}`);
            queueMessage(reqId, `[wecombot] [${bot.name || bot.botId}] [${userId}] 发送了视频: ${filepath}`, session);
          } catch (err) {
            logError(`[wecombot] 视频下载失败:`, err);
            queueMessage(reqId, `[wecombot] [${bot.name || bot.botId}] [${userId}] 发送了视频（下载失败）: ${url}`, session);
          }
        }
      });

      ws.on("event.enter_chat", (frame: any) => {
        ws && ws.replyWelcome(frame, { msgtype: "text", text: { content: `👋 你好！我是 ${bot.name || "AI"} 助手，有什么可以帮你的吗？` } });
      });

      ws.on("disconnected", (reason?: string) => {
        const wasConnected = connected;
        connected = false;
        sessions.clear();

        if (isManualDisconnect) {
          log(`[wecombot] ℹ️ ${bot.name || bot.botId} 已主动断开连接`);
          setStatus(currentCtx);
          return;
        }

        const isKicked = reason?.includes("kick") || reason?.includes("replaced") || reason === "connection replaced";
        const disconnectMsg = isKicked ? `被其他会话踢掉` : `断开`;

        log(`[wecombot] ❌ ${bot.name || bot.botId} ${disconnectMsg}${reason ? `: ${reason}` : ""}`);

        // 使用 currentCtx 而不是捕获的 ctx，避免 session 替换后 ctx 已失效
        const activeCtx = currentCtx;
        if (isKicked) {
          setStatus(activeCtx, `被其他会话连接 (${sessionId.slice(0, 4)})`);
        } else {
          // 普通网络异常断开（如 1006），SDK 会自动触发 reconnecting
          setStatus(activeCtx, "已断开，准备重连");
        }
      });

      ws.on("error", (err: any) => {
        const errMsg = String(err);
        log(`[wecombot] ❌ ${bot.name || bot.botId}`, err);
        connected = false;

        // 使用 currentCtx 而不是捕获的 ctx，避免 session 替换后 ctx 已失效
        const activeCtx = currentCtx;
        if (errMsg.includes("already connected") || errMsg.includes("connection refused")) {
          setStatus(activeCtx, "连接被占用");
          try {
            activeCtx?.ui.notify(`❌ ${bot.name || bot.botId} 连接失败：该机器人已在其他会话连接`, "error");
          } catch (e: any) {
            if (!e?.message?.includes("stale")) throw e;
          }
        } else {
          setStatus(activeCtx, errMsg);
        }
      });

      ws.connect();
      return true;
    } catch (err) {
      logError(`[wecombot] 连接异常:`, err);
      connected = false;
      setStatus(ctx, "连接异常");
      return false;
    }
  }

  function disconnect() {
    isManualDisconnect = true;
    sessions.clear();
    if (ws) { ws.disconnect(); ws = null; }
    connected = false;
  }

  // ============================================================================
  // Tools
  // ============================================================================

  function registerTools() {
    pi.registerTool({
      name: "wecombot-attach",
      label: "发送文件",
      description: "发送本地文件到企业微信",
      promptSnippet: "Attach and send local files to WeCom chat",
      parameters: Type.Object({
        paths: Type.Array(Type.String(), { minItems: 1, maxItems: 10 }),
      }),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        if (!isWecomConnected()) return { content: [{ type: "text", text: "⚠️ 机器人未连接" }], details: {} };
        const reqId = currentReqId || sessions.keys().next().value;
        if (!reqId) return { content: [{ type: "text", text: "⚠️ 无法发送：企业微信需要先收到用户消息才能回复。请等待用户发消息后再发送。" }], details: {} };
        const files: string[] = [];
        for (const fp of params.paths) if ((await stat(fp)).isFile()) files.push(fp);
        for (const fp of files) replyTo(reqId, `📎 ${basename(fp)}`, true);
        return { content: [{ type: "text", text: `已添加 ${files.length} 个文件` }], details: {} };
      },
    });


    pi.registerTool({
      name: "wecombot-send",
      label: "发送消息",
      description: "向企业微信发送即时消息。注意：普通对话回复会在回合结束时自动发送给用户，无需调用此工具；仅在需要提前发送中间进展或多段独立消息时使用。",
      promptSnippet: "Send an intermediate text message to WeCom chat",
      parameters: Type.Object({
        message: Type.String(),
      }),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        if (!isWecomConnected()) return { content: [{ type: "text", text: "⚠️ 机器人未连接" }], details: {} };
        const reqId = currentReqId || sessions.keys().next().value;
        if (!reqId) return { content: [{ type: "text", text: "⚠️ 无法发送：企业微信需要先收到用户消息才能回复。请等待用户发消息后再发送。" }], details: {} };
        replyTo(reqId, params.message, true);
        hasSentViaTool = true;
        return { content: [{ type: "text", text: "✅ 已发送" }], details: {} };
      },
    });
  }

  // 首次加载时注册工具（用于会话恢复场景）
  if (!toolsRegistered && isWecomConnected()) {
    registerTools();
    toolsRegistered = true;
  }

  // ============================================================================
  // Commands
  // ============================================================================

  // 【全局配置】添加机器人 - 所有会话可见
  pi.registerCommand("wecombot-add", {
    description: "添加机器人（全局）",
    handler: async (_args, ctx) => {
      const name = await ctx.ui.input("机器人名称(可选)", "");
      const botId = await ctx.ui.input("BotID", "wwxxxxxxxxxxxxxxx");
      if (!botId) return;
      const secret = await ctx.ui.input("Secret", "");
      if (!secret) return;

      const globalCfg = await loadGlobalConfig();

      if (globalCfg.bots.find(b => b.botId === botId.trim())) {
        ctx.ui.notify("❌ 该机器人已存在", "error");
        return;
      }

      globalCfg.bots.push({
        botId: botId.trim(),
        secret: secret.trim(),
        name: name?.trim() || undefined
      });
      await saveGlobalConfig(globalCfg);

      globalBots = globalCfg.bots;

      if (!sessionCfg.activeBotId) {
        sessionCfg.activeBotId = botId.trim();
        sessionCfg.enabled = true;
        await saveSessionConfig(sessionCfg);
      }

      ctx.ui.notify(`✅ 已添加 ${name || botId.slice(0, 8)}（全局配置）`, "info");

      const newBot = globalBots[globalBots.length - 1];
      await connect(ctx, newBot);
    },
  });

  // 【全局配置】列出所有机器人
  pi.registerCommand("wecombot-list", {
    description: "列出所有机器人（全局）",
    handler: async (_args, ctx) => {
      const globalCfg = await loadGlobalConfig();
      globalBots = globalCfg.bots;

      if (globalBots.length === 0) {
        ctx.ui.notify("全局暂无配置的机器人", "info");
      } else {
        const list = globalBots.map(b => {
          const isSessionActive = b.botId === sessionCfg.activeBotId ? "▶" : "○";
          const isConnected = connected && b.botId === sessionCfg.activeBotId ? "✅" : "";
          return `${isSessionActive} ${isConnected} ${b.name || b.botId}`;
        }).join("\n");
        const sessionInfo = sessionCfg.activeBotId ? `本会话启用: ${getActiveBot(globalBots, sessionCfg.activeBotId)?.name || sessionCfg.activeBotId}` : "本会话未启用机器人";
        ctx.ui.notify(`全局机器人列表（共 ${globalBots.length} 个）: ${list}${sessionInfo}`, "info");
      }
    },
  });

  // 【会话配置】切换当前会话启用的机器人
  pi.registerCommand("wecombot-use", {
    description: "切换机器人（本会话）",
    handler: async (_args, ctx) => {
      const globalCfg = await loadGlobalConfig();
      globalBots = globalCfg.bots;

      if (globalBots.length === 0) {
        ctx.ui.notify("暂无配置的机器人，请先添加", "warning");
        return;
      }

      const options = globalBots.map(b =>
        `${b.botId === sessionCfg.activeBotId ? "▶ " : "○ "}${b.name || b.botId}`
      );

      const selected = await ctx.ui.select("选择机器人（仅本会话）", options);
      if (!selected) return;

      const selectedLabel = selected.replace(/^[▶○] /, "");
      const bot = globalBots.find(b => b.botId === selectedLabel || (b.name || b.botId) === selectedLabel);
      if (!bot) {
        ctx.ui.notify("❌ 机器人不存在", "error");
        return;
      }

      sessionCfg.activeBotId = bot.botId;
      sessionCfg.enabled = true;
      await saveSessionConfig(sessionCfg);

      ctx.ui.notify(`✅ 本会话已切换到 ${bot.name || bot.botId}`, "info");
      await connect(ctx, bot);
    },
  });

  // 【全局配置】删除机器人
  pi.registerCommand("wecombot-remove", {
    description: "删除机器人（全局）",
    handler: async (_args, ctx) => {
      const globalCfg = await loadGlobalConfig();
      globalBots = globalCfg.bots;

      if (globalBots.length === 0) {
        ctx.ui.notify("暂无配置的机器人", "warning");
        return;
      }

      const name = await ctx.ui.input("输入要删除的BotID或名称", "");
      if (!name) return;

      const idx = globalBots.findIndex(b => b.botId === name || b.name === name);
      if (idx === -1) {
        ctx.ui.notify("❌ 机器人不存在", "error");
        return;
      }

      const removed = globalBots.splice(idx, 1)[0];

      await saveGlobalConfig({ bots: globalBots });

      if (sessionCfg.activeBotId === removed.botId) {
        disconnect();
        sessionCfg.activeBotId = globalBots[0]?.botId;
        await saveSessionConfig(sessionCfg);

        if (globalBots.length > 0) {
          ctx.ui.notify(`✅ 已删除 ${removed.name || removed.botId}，自动切换到下一个`, "info");
          const nextBot = getActiveBot(globalBots, sessionCfg.activeBotId);
          if (nextBot && sessionCfg.enabled) await connect(ctx, nextBot);
        } else {
          ctx.ui.notify(`✅ 已删除 ${removed.name || removed.botId}（无可用机器人）`, "info");
        }
      } else {
        ctx.ui.notify(`✅ 已删除 ${removed.name || removed.botId}`, "info");
      }
    },
  });

  // 【混合】状态查看
  pi.registerCommand("wecombot-status", {
    description: "查看机器人状态",
    handler: async (_args, ctx) => {
      const globalCfg = await loadGlobalConfig();
      globalBots = globalCfg.bots;

      const active = getActiveBot(globalBots, sessionCfg.activeBotId);
      if (!active) {
        ctx.ui.notify(
          `全局机器人: ${globalBots.length} 个
本会话状态: 未选择机器人`,
          "info"
        );
        return;
      }

      let statusIcon: string;
      let statusText: string;

      if (!sessionCfg.enabled) {
        statusIcon = "🔴";
        statusText = "已禁用";
      } else if (connected) {
        statusIcon = "✅";
        statusText = "已连接";
      } else {
        statusIcon = "❌";
        statusText = "已断开";
      }

      ctx.ui.notify(
        `${statusIcon} ${active.name || active.botId}
状态: ${statusText}
全局机器人: ${globalBots.length} 个
本会话活跃会话: ${sessions.size} 个
会话ID: ${sessionId.slice(0, 8)}`,
        "info"
      );
    },
  });

  // 【会话配置】启用本会话连接
  pi.registerCommand("wecombot-enable", {
    description: "启用机器人（本会话）",
    handler: async (_args, ctx) => {
      if (sessionCfg.enabled) {
        ctx.ui.notify("本会话机器人已是启用状态", "info");
        return;
      }
      sessionCfg.enabled = true;
      await saveSessionConfig(sessionCfg);

      const bot = getActiveBot(globalBots, sessionCfg.activeBotId);
      if (bot) {
        await connect(ctx, bot);
        ctx.ui.notify(`✅ 本会话已启用并连接 ${bot.name || bot.botId}`, "info");
      } else {
        ctx.ui.notify("✅ 本会话已启用，但未选择机器人，请先添加或使用 /wecombot-use 选择", "warning");
      }
      setStatus(ctx);
    },
  });

  // 【会话配置】禁用本会话连接
  pi.registerCommand("wecombot-disable", {
    description: "禁用机器人（本会话）",
    handler: async (_args, ctx) => {
      if (!sessionCfg.enabled) {
        ctx.ui.notify("本会话机器人已是禁用状态", "info");
        return;
      }
      sessionCfg.enabled = false;
      await saveSessionConfig(sessionCfg);
      disconnect();
      ctx.ui.notify("🔌 本会话已禁用机器人并断开连接", "info");
      setStatus(ctx);
    },
  });

  // 【会话】查看会话详情
  pi.registerCommand("wecombot-session", {
    description: "查看当前会话详情",
    handler: async (_args, ctx) => {
      if (sessions.size === 0) {
        ctx.ui.notify("暂无活跃会话", "info");
        return;
      }
      const active = getActiveBot(globalBots, sessionCfg.activeBotId);
      const sessionList = Array.from(sessions.entries()).map(([reqId, s]) =>
        `[${active?.name || s.botId}]
  reqId: ${reqId}
  userId: ${s.userId}
  chatId: ${s.chatId}`
      ).join("\n\n");
      ctx.ui.notify(`当前会话:
${sessionList}`, "info");
    },
  });

  // 【会话】查看会话信息
  pi.registerCommand("wecombot-session-info", {
    description: "查看会话信息",
    handler: async (_args, ctx) => {
      const info = [
        `会话ID: ${sessionId}`,
        `全局配置: ${GLOBAL_CONFIG}`,
        `会话配置: ${sessionConfigPath}`,
        `临时目录: ${getTempDir()}`,
        ``,
        `【全局】机器人数量: ${globalBots.length}`,
        `【会话】启用机器人: ${sessionCfg.activeBotId || "无"}`,
        `【会话】启用状态: ${sessionCfg.enabled ? "✅" : "🔴"}`,
        `【会话】连接状态: ${connected ? "🟢 已连接" : "⚪ 未连接"}`,
        `【会话】活跃消息会话: ${sessions.size} 个`,
      ].join("\n");
      ctx.ui.notify(info, "info");
    },
  });

  // 【会话】新建会话并切换（联动企微与 Web）
  pi.registerCommand("wecombot-new", {
    description: "新建会话并切换（联动企微与 Web）",
    handler: async (_args, ctx) => {
      const active = getActiveBot(globalBots, sessionCfg.activeBotId);
      if (!active) {
        ctx.ui.notify("当前未配置或未选择机器人", "error");
        return;
      }
      ctx.ui.notify("🔄 正在创建并切换新会话...", "info");
      const fakeSession: Session = {
        frame: null,
        streamId: "",
        userId: "local",
        chatId: "",
        timestamp: Date.now(),
        botId: active.botId,
      };
      await handleNewSessionCommand(generateReqId("cmd"), fakeSession, active);
      ctx.ui.notify("✅ 新会话已创建，机器人已切换", "info");
    },
  });

  // 同时也注册 /new 指令（便于在 Web 端或终端直接使用 /new 联动）
  pi.registerCommand("new", {
    description: "开启新会话（联动企微与 Web）",
    handler: async (_args, ctx) => {
      const active = getActiveBot(globalBots, sessionCfg.activeBotId);
      ctx.ui.notify("🔄 正在创建并切换新会话...", "info");
      const fakeSession: Session = {
        frame: null,
        streamId: "",
        userId: "local",
        chatId: "",
        timestamp: Date.now(),
        botId: active?.botId || "",
      };
      if (active) {
        await handleNewSessionCommand(generateReqId("cmd"), fakeSession, active);
        ctx.ui.notify("✅ 新会话已创建，机器人已切换", "info");
      } else {
        const cwd = ctx.cwd || process.cwd();
        const globalCfg = await loadGlobalConfig();
        const piWebUrl = getPiWebUrl(globalCfg);
        try {
          const res = await fetch(`${piWebUrl}/api/agent/new`, {
            method: "POST",
            headers: getPiWebHeaders(),
            body: JSON.stringify({ cwd, type: "ensure_session" }),
          });
          if (res.ok) {
            ctx.ui.notify("✅ 已通过 Web 创建新会话", "info");
          } else {
            await createFallbackSession(cwd);
            ctx.ui.notify("✅ 已创建新会话", "info");
          }
        } catch {
          await createFallbackSession(cwd);
          ctx.ui.notify("✅ 已创建新会话", "info");
        }
      }
    },
  });

  // ============================================================================
  // Events
  // ============================================================================

  pi.on("session_start", async (_e, ctx) => {
    try {
      // 保存当前会话的 ctx，供 WebSocket 回调使用
      currentCtx = ctx;

      // 解析稳定会话身份（此处才有 ctx），初始化会话级路径
      sessionId = resolveSessionId(ctx);
      sessionConfigPath = getSessionConfigPath(sessionId);
      tempDir = getSessionTempPath(sessionId);
      log(`[wecombot] 会话ID: ${sessionId.slice(0, 8)}`);
      log(`[wecombot] 会话配置: ${sessionConfigPath}`);

      // 加载全局机器人列表
      const globalCfg = await loadGlobalConfig();
      globalBots = globalCfg.bots;

      // 加载本会话配置
      sessionCfg = await loadSessionConfig();

      await mkdir(tempDir, { recursive: true });

      // 如果启用了且选择了机器人，则尝试连接（失败不影响 pi）
      if (sessionCfg.enabled && sessionCfg.activeBotId) {
        const bot = getBotById(globalBots, sessionCfg.activeBotId);
        if (bot) {
          const success = await connect(ctx, bot);
          if (!success) {
            log(`[wecombot] 连接失败，但不影响 pi 使用`);
          }
        }
      }
      // 注意：不调用 setStatus，连接过程中 ws.on('connected') 会自动调用
    } catch (err) {
      logError(`[wecombot] session_start 异常:`, err);
      // 不影响 pi 启动
    }
  });

  pi.on("session_shutdown", () => {
    try {
      disconnect();
    } catch (err) {
      logError(`[wecombot] session_shutdown 异常:`, err);
    }
  });

  pi.on("before_agent_start", async (e) => ({
    systemPrompt: e.systemPrompt + PROMPT,
  }));

  pi.on("agent_end", async (e, ctx) => {
    setStatus(ctx);

    // 检查当前是否有正在处理的消息
    if (!currentReqId || pendingMessages.length === 0) return;

    // 确认是当前请求的回复
    const pending = pendingMessages[0];
    if (pending.reqId !== currentReqId) return;

    const msg = e.messages[e.messages.length - 1] as any;
    if (!msg?.content) {
      // 没有回复内容，移除消息并继续处理下一条
      clearProgressNotifier(currentReqId);
      hasSentViaTool = false;
      pendingMessages.shift();
      currentReqId = null;
      processMessageQueue();
      return;
    }

    const txt = (msg.content as any[])?.find((b: any) => b.type === "text")?.text;
    if (!txt) {
      clearProgressNotifier(currentReqId);
      hasSentViaTool = false;
      pendingMessages.shift();
      currentReqId = null;
      processMessageQueue();
      return;
    }

    const active = getActiveBot(globalBots, sessionCfg.activeBotId);
    const pattern = new RegExp(`\\[wecombot\\] \\[${active?.name || active?.botId || ""}\\] \\[([^\\]]+)\\]\\n?`, "g");
    const replyContent = txt.replace(pattern, "");

    // 回复给对应的用户
    if (replyContent.trim()) {
      if (hasSentViaTool) {
        log(`[wecombot] 当前请求已通过工具发送过内容，跳过 agent_end 自动发送（避免覆盖或重复发送确认语）: ${replyContent.slice(0, 30)}`);
      } else {
        replyTo(pending.reqId, replyContent, true);
      }
    }

    // 【增强】清理进度通知定时器
    clearProgressNotifier(currentReqId);
    hasSentViaTool = false;

    // 移除已处理的消息
    pendingMessages.shift();
    currentReqId = null;

    // 处理下一条消息
    processMessageQueue();
  });
}
