import {
  Avatar,
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  FluentProvider,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Skeleton,
  SkeletonItem,
  Textarea,
  Tooltip,
  createDarkTheme,
  createLightTheme,
  type BrandVariants,
} from "@fluentui/react-components";
import {
  ArrowSyncRegular,
  BotRegular,
  CheckmarkCircleRegular,
  ChatMultipleRegular,
  CopyRegular,
  DismissRegular,
  KeyRegular,
  LockClosedRegular,
  PersonAddRegular,
  SendRegular,
  SignOutRegular,
  WeatherMoonRegular,
  WeatherSunnyRegular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CreateInviteResponse,
  CreateSessionResponse,
  JoinInviteResponse,
  Member,
  Message,
  MessageKind,
  RealtimeEnvelope,
  Session,
} from "@codex-collab/protocol";
import { copyText } from "./clipboard.js";

const brand: BrandVariants = {
  10: "#02040C",
  20: "#07102D",
  30: "#0B1C52",
  40: "#11297A",
  50: "#1737A1",
  60: "#2047CB",
  70: "#2E5BFF",
  80: "#5378FF",
  90: "#7896FF",
  100: "#9BB1FF",
  110: "#B8C7FF",
  120: "#CFDAFF",
  130: "#E0E7FF",
  140: "#EDF1FF",
  150: "#F5F7FF",
  160: "#FBFCFF",
};

const lightTheme = createLightTheme(brand);
const darkTheme = createDarkTheme(brand);
const storageKey = "codexCollab";

type ThemeMode = "light" | "dark";
type ConnectionState = "ready" | "connecting" | "live" | "waiting" | "error";

interface SavedCredential {
  session: Session;
  member: Member;
  token: string;
}

interface ActivityItem {
  id: string;
  title: string;
  detail: string;
  createdAt: string;
  tone: "info" | "success" | "warning" | "danger";
}

interface ApiErrorBody {
  error?: {
    message?: string;
  };
}

function loadCredential(): SavedCredential | null {
  const saved = sessionStorage.getItem(storageKey);
  if (!saved) {
    return null;
  }
  try {
    const parsed = JSON.parse(saved) as SavedCredential;
    if (!parsed.session?.id || !parsed.member?.id || !parsed.token) {
      throw new Error("invalid saved session");
    }
    return parsed;
  } catch {
    sessionStorage.removeItem(storageKey);
    return null;
  }
}

async function requestJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  const body = (await response.json()) as T & ApiErrorBody;
  if (!response.ok) {
    throw new Error(body.error?.message ?? "请求未完成");
  }
  return body;
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function deviceLabel(): string {
  return navigator.platform || "Web device";
}

function inviteTokenFromLocation(): string {
  const parameters = new URLSearchParams(window.location.hash.slice(1));
  return parameters.get("invite")?.trim() ?? "";
}

function inviteLinkForCurrentOrigin(inviteToken: string): string {
  const url = new URL("/", window.location.origin);
  url.hash = new URLSearchParams({ invite: inviteToken }).toString();
  return url.toString();
}

function isLoopbackOrigin(): boolean {
  return (
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "::1"
  );
}

export function App() {
  const initialCredential = useMemo(loadCredential, []);
  const initialInviteToken = useMemo(inviteTokenFromLocation, []);
  const [credential, setCredential] = useState<SavedCredential | null>(initialCredential);
  const [members, setMembers] = useState<Member[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activities, setActivities] = useState<ActivityItem[]>([
    {
      id: crypto.randomUUID(),
      title: "Relay 已启动",
      detail: "等待协作会话",
      createdAt: new Date().toISOString(),
      tone: "info",
    },
  ]);
  const [connection, setConnection] = useState<ConnectionState>(
    initialCredential?.member.status === "pending" ? "waiting" : "ready",
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(!initialCredential);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteLink, setInviteLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [displayName, setDisplayName] = useState(initialInviteToken ? "" : "Owner");
  const [roomName, setRoomName] = useState("Codex shared task");
  const [joinToken, setJoinToken] = useState(initialInviteToken);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const messageStreamRef = useRef<HTMLElement>(null);
  const inviteLinkRef = useRef<HTMLInputElement>(null);

  const session = credential?.session ?? null;
  const member = credential?.member ?? null;
  const token = credential?.token ?? null;
  const approved = member?.status === "approved";

  const pushActivity = useCallback(
    (
      title: string,
      detail: string,
      tone: ActivityItem["tone"] = "info",
    ) => {
      setActivities((current) =>
        [
          {
            id: crypto.randomUUID(),
            title,
            detail,
            tone,
            createdAt: new Date().toISOString(),
          },
          ...current,
        ].slice(0, 8),
      );
    },
    [],
  );

  const showError = useCallback(
    (caught: unknown) => {
      const message = caught instanceof Error ? caught.message : "请求未完成";
      setError(message);
      setConnection("error");
      pushActivity("操作未完成", message, "danger");
    },
    [pushActivity],
  );

  const saveCredential = useCallback((next: SavedCredential) => {
    setCredential(next);
    sessionStorage.setItem(storageKey, JSON.stringify(next));
  }, []);

  const authHeaders = useCallback(
    (includeJson = false): HeadersInit => ({
      authorization: `Bearer ${token ?? ""}`,
      ...(includeJson ? { "content-type": "application/json" } : {}),
    }),
    [token],
  );

  const addMessage = useCallback((next: Message) => {
    setMessages((current) =>
      current.some((message) => message.id === next.id)
        ? current
        : [...current, next],
    );
  }, []);

  const refresh = useCallback(async () => {
    if (!session || !token || !approved) {
      return;
    }
    setLoading(true);
    try {
      const [messageResult, memberResult, meResult] = await Promise.all([
        requestJson<{ messages: Message[] }>(
          `/v1/sessions/${session.id}/messages`,
          { headers: authHeaders() },
        ),
        requestJson<{ members: Member[] }>(
          `/v1/sessions/${session.id}/members`,
          { headers: authHeaders() },
        ),
        requestJson<{ member: Member }>(`/v1/sessions/${session.id}/me`, {
          headers: authHeaders(),
        }),
      ]);
      setMessages(messageResult.messages);
      setMembers(memberResult.members);
      if (meResult.member.status !== member.status) {
        saveCredential({ session, member: meResult.member, token });
      }
      setError(null);
    } catch (caught) {
      showError(caught);
    } finally {
      setLoading(false);
    }
  }, [approved, authHeaders, member, saveCredential, session, showError, token]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => {
      setThemeMode(event.matches ? "dark" : "light");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    document.documentElement.style.colorScheme = themeMode;
  }, [themeMode]);

  useEffect(() => {
    const stream = messageStreamRef.current;
    if (stream) {
      stream.scrollTop = stream.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (!approved) {
      return;
    }
    void refresh();
  }, [approved, refresh]);

  useEffect(() => {
    if (!session || !token || member?.status !== "pending") {
      return;
    }
    let stopped = false;
    let timer: number | undefined;

    const checkApproval = async () => {
      try {
        const result = await requestJson<{ member: Member }>(
          `/v1/sessions/${session.id}/me`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (stopped) {
          return;
        }
        if (result.member.status === "approved") {
          saveCredential({ session, member: result.member, token });
          setConnection("connecting");
          setError(null);
          pushActivity("主人已批准", "实时协作已启用", "success");
          return;
        }
      } catch (caught) {
        if (!stopped) {
          setError(caught instanceof Error ? caught.message : "无法检查批准状态");
          setConnection("error");
        }
      }
      if (!stopped) {
        timer = window.setTimeout(checkApproval, 2000);
      }
    };

    void checkApproval();
    return () => {
      stopped = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [member?.status, pushActivity, saveCredential, session, token]);

  useEffect(() => {
    if (!session || !token || !approved) {
      return;
    }
    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;

    const connect = () => {
      setConnection("connecting");
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const query = new URLSearchParams({ sessionId: session.id, token });
      socket = new WebSocket(
        `${protocol}//${location.host}/v1/realtime?${query.toString()}`,
      );
      socket.addEventListener("open", () => {
        if (!stopped) {
          setConnection("live");
          setError(null);
        }
      });
      socket.addEventListener("message", (event) => {
        const envelope = JSON.parse(event.data as string) as RealtimeEnvelope;
        if (envelope.type === "message.created") {
          const next = envelope.payload as Message;
          addMessage(next);
          pushActivity("收到新消息", next.senderDisplayName, "info");
        }
        if (envelope.type === "member.updated") {
          const next = envelope.payload as Member;
          pushActivity("成员状态已变化", next.displayName, "success");
          void refresh();
        }
      });
      socket.addEventListener("close", () => {
        if (!stopped) {
          setConnection("connecting");
          reconnectTimer = window.setTimeout(connect, 1500);
        }
      });
      socket.addEventListener("error", () => {
        if (!stopped) {
          setConnection("error");
        }
      });
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
  }, [addMessage, approved, pushActivity, refresh, session, token]);

  const createSession = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      const result = await requestJson<CreateSessionResponse>("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: roomName,
          ownerDisplayName: displayName,
          deviceLabel: deviceLabel(),
        }),
      });
      saveCredential({
        session: result.session,
        member: result.owner,
        token: result.memberToken,
      });
      setMembers([result.owner]);
      setSetupOpen(false);
      setConnection("connecting");
      setError(null);
      pushActivity("共享任务已创建", "你是主人", "success");
    } catch (caught) {
      showError(caught);
    } finally {
      setSubmitting(false);
    }
  };

  const joinSession = async () => {
    setSubmitting(true);
    try {
      const result = await requestJson<JoinInviteResponse>("/v1/invites/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inviteToken: joinToken,
          displayName,
          deviceLabel: deviceLabel(),
        }),
      });
      saveCredential({
        session: result.session,
        member: result.member,
        token: result.memberToken,
      });
      setMembers([result.member]);
      setSetupOpen(false);
      setConnection("waiting");
      setError(null);
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      pushActivity("加入申请已发送", "等待主人批准", "warning");
    } catch (caught) {
      showError(caught);
    } finally {
      setSubmitting(false);
    }
  };

  const sendMessage = async (kind: MessageKind) => {
    const body = draft.trim();
    if (!session || !token || !body || !approved) {
      return;
    }
    setDraft("");
    setSubmitting(true);
    try {
      const result = await requestJson<{ message: Message }>(
        `/v1/sessions/${session.id}/messages`,
        {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify({ kind, body }),
        },
      );
      addMessage(result.message);
      if (kind === "codex_prompt") {
        pushActivity("已交给 Codex", member?.displayName ?? "协作者", "success");
      }
    } catch (caught) {
      setDraft(body);
      showError(caught);
    } finally {
      setSubmitting(false);
    }
  };

  const approveMember = async (target: Member) => {
    if (!session) {
      return;
    }
    try {
      await requestJson<{ member: Member }>(
        `/v1/sessions/${session.id}/members/${target.id}/approve`,
        {
          method: "POST",
          headers: authHeaders(true),
          body: "{}",
        },
      );
      pushActivity("成员已批准", target.displayName, "success");
      await refresh();
    } catch (caught) {
      showError(caught);
    }
  };

  const createInvite = async () => {
    if (!session) {
      return;
    }
    try {
      const result = await requestJson<CreateInviteResponse>(
        `/v1/sessions/${session.id}/invites`,
        {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify({ expiresInMinutes: 60, maxUses: 1 }),
        },
      );
      setInviteLink(inviteLinkForCurrentOrigin(result.inviteToken));
      setCopied(false);
      setCopyFailed(false);
      setInviteOpen(true);
      pushActivity("邀请已创建", "60 分钟内可使用一次", "success");
    } catch (caught) {
      showError(caught);
    }
  };

  const copyInvite = async () => {
    const copiedSuccessfully = await copyText(inviteLink, inviteLinkRef.current ?? undefined);
    setCopied(copiedSuccessfully);
    setCopyFailed(!copiedSuccessfully);
    if (copiedSuccessfully) {
      pushActivity("邀请链接已复制", "可以发送给协作者", "success");
    } else {
      inviteLinkRef.current?.focus();
      inviteLinkRef.current?.select();
    }
  };

  const resetSession = () => {
    sessionStorage.removeItem(storageKey);
    setCredential(null);
    setMembers([]);
    setMessages([]);
    setError(null);
    setConnection("ready");
    setSetupOpen(true);
    pushActivity("已离开本机会话", "服务器数据未删除", "info");
  };

  const owner = members.find((item) => item.role === "owner");
  const status = connectionPresentation(connection, Boolean(session));

  return (
    <FluentProvider
      theme={themeMode === "dark" ? darkTheme : lightTheme}
      className="app-provider"
    >
      <div className="app-frame">
        <header className="topbar">
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true">
              <ChatMultipleRegular />
            </div>
            <div>
              <div className="product-context">共享 Codex 工作区</div>
              <h1>Codex Collab</h1>
            </div>
          </div>

          <div className="topbar-actions">
            {member?.role === "owner" && approved ? (
              <Button
                appearance="secondary"
                icon={<PersonAddRegular />}
                onClick={createInvite}
              >
                创建邀请
              </Button>
            ) : null}
            <Tooltip content="切换明暗主题" relationship="label">
              <Button
                appearance="subtle"
                icon={
                  themeMode === "dark" ? (
                    <WeatherSunnyRegular />
                  ) : (
                    <WeatherMoonRegular />
                  )
                }
                aria-label="切换明暗主题"
                onClick={() =>
                  setThemeMode((current) =>
                    current === "dark" ? "light" : "dark",
                  )
                }
              />
            </Tooltip>
            {session ? (
              <Tooltip content="离开本机会话" relationship="label">
                <Button
                  appearance="subtle"
                  icon={<SignOutRegular />}
                  aria-label="离开本机会话"
                  onClick={resetSession}
                />
              </Tooltip>
            ) : null}
            <Badge appearance="tint" color={status.color} size="large">
              {status.label}
            </Badge>
          </div>
        </header>

        {error ? (
          <div className="error-region" role="alert">
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>需要处理</MessageBarTitle>
                {error}
              </MessageBarBody>
              <Button
                appearance="transparent"
                icon={<DismissRegular />}
                aria-label="关闭错误"
                onClick={() => setError(null)}
              />
            </MessageBar>
          </div>
        ) : null}

        <div className="workspace">
          <aside className="people-panel" aria-label="协作成员">
            <div className="panel-heading">
              <div>
                <h2>协作成员</h2>
                <p>身份与访问状态</p>
              </div>
              <span>{members.length} 人</span>
            </div>

            <div className="member-list">
              {loading && members.length === 0 ? (
                <MemberSkeleton />
              ) : members.length === 0 ? (
                <div className="panel-empty">连接会话后显示成员</div>
              ) : (
                members.map((item) => (
                  <div className="member-row" key={item.id}>
                    <Avatar
                      name={item.displayName}
                      color={item.role === "owner" ? "brand" : "colorful"}
                    />
                    <div className="member-copy">
                      <strong>{item.displayName}</strong>
                      <span>{item.role === "owner" ? "主人" : "协作者"}</span>
                    </div>
                    {member?.role === "owner" && item.status === "pending" ? (
                      <Button
                        appearance="primary"
                        size="small"
                        onClick={() => approveMember(item)}
                      >
                        批准
                      </Button>
                    ) : (
                      <Badge
                        appearance="tint"
                        color={item.status === "approved" ? "success" : "warning"}
                      >
                        {item.status === "approved" ? "已批准" : "等待中"}
                      </Badge>
                    )}
                  </div>
                ))
              )}
            </div>

            <div className="handoff-rail">
              <div className="handoff-icon" aria-hidden="true">
                <LockClosedRegular />
              </div>
              <div>
                <span>Codex 控制权</span>
                <strong>
                  {owner ? `${owner.displayName} 的 Codex` : "等待绑定主人"}
                </strong>
                <p>协作者指令进入同一任务，关键操作仍由主人审批。</p>
              </div>
            </div>
          </aside>

          <main className="chat-panel">
            <div className="chat-heading">
              <div>
                <p className="session-id">
                  {session ? session.id : "尚未连接会话"}
                </p>
                <h2>{session?.name ?? "开始一个共享任务"}</h2>
              </div>
              {approved ? (
                <Tooltip content="刷新消息和成员" relationship="label">
                  <Button
                    appearance="subtle"
                    icon={<ArrowSyncRegular />}
                    aria-label="刷新消息和成员"
                    onClick={() => void refresh()}
                  />
                </Tooltip>
              ) : null}
            </div>

            <section
              className="message-stream"
              aria-label="实时对话"
              ref={messageStreamRef}
            >
              {loading && messages.length === 0 ? (
                <MessageSkeleton />
              ) : messages.length === 0 ? (
                <div className="message-empty">
                  {member?.status === "pending" ? (
                    <>
                      <LockClosedRegular />
                      <h3>等待主人批准</h3>
                      <p>批准后，对话记录和 Codex 指令会在这里实时同步。</p>
                    </>
                  ) : (
                    <>
                      <ChatMultipleRegular />
                      <h3>共享对话从这里开始</h3>
                      <p>创建会话或使用邀请加入，双方消息会按身份显示。</p>
                    </>
                  )}
                </div>
              ) : (
                messages.map((item) => {
                  const mine = item.senderMemberId === member?.id;
                  return (
                    <article
                      className={`message ${mine ? "mine" : ""} ${
                        item.kind === "codex_prompt" ? "codex-message" : ""
                      }`}
                      key={item.id}
                    >
                      <div className="message-meta">
                        <span>{item.senderDisplayName}</span>
                        <span>
                          {item.kind === "codex_prompt" ? "Codex 指令" : "消息"}
                        </span>
                        <time dateTime={item.createdAt}>
                          {timeLabel(item.createdAt)}
                        </time>
                      </div>
                      <div className="message-bubble">
                        {item.kind === "codex_prompt" ? (
                          <BotRegular aria-hidden="true" />
                        ) : null}
                        <p>{item.body}</p>
                      </div>
                    </article>
                  );
                })
              )}
            </section>

            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                void sendMessage("chat");
              }}
            >
              <Field
                label="发送到共享任务"
                hint={
                  approved
                    ? "普通消息用于讨论，Codex 指令会发送给主人的 Codex。"
                    : "连接并通过批准后即可发送。"
                }
              >
                <Textarea
                  value={draft}
                  resize="vertical"
                  disabled={!approved || submitting}
                  placeholder="输入消息或要 Codex 执行的任务"
                  onChange={(_, data) => setDraft(data.value)}
                />
              </Field>
              <div className="composer-actions">
                <Button
                  type="button"
                  appearance="secondary"
                  icon={<BotRegular />}
                  disabled={!approved || !draft.trim() || submitting}
                  onClick={() => void sendMessage("codex_prompt")}
                >
                  交给 Codex
                </Button>
                <Button
                  type="submit"
                  appearance="primary"
                  icon={<SendRegular />}
                  disabled={!approved || !draft.trim() || submitting}
                >
                  发送消息
                </Button>
              </div>
            </form>
          </main>

          <aside className="activity-panel" aria-label="任务活动">
            <div className="panel-heading">
              <div>
                <h2>任务活动</h2>
                <p>最近的协作事件</p>
              </div>
              <span>实时</span>
            </div>
            <div className="activity-list">
              {activities.map((item) => (
                <div className={`activity-item ${item.tone}`} key={item.id}>
                  <div className="activity-line" aria-hidden="true">
                    <span />
                  </div>
                  <div>
                    <strong>{item.title}</strong>
                    <p>{item.detail}</p>
                    <time dateTime={item.createdAt}>
                      {timeLabel(item.createdAt)}
                    </time>
                  </div>
                </div>
              ))}
            </div>
          </aside>
        </div>
      </div>

      <Dialog open={setupOpen} modalType="alert">
        <DialogSurface>
          <form onSubmit={createSession}>
            <DialogBody>
              <DialogTitle>连接协作会话</DialogTitle>
              <DialogContent className="setup-fields">
                <p className="dialog-intro">
                  {initialInviteToken
                    ? "你收到了一次性协作邀请。填写显示名称后申请加入。"
                    : "创建一个新任务，或使用一次性令牌加入已有任务。"}
                </p>
                <Field label="你的显示名称" required>
                  <Input
                    value={displayName}
                    maxLength={80}
                    onChange={(_, data) => setDisplayName(data.value)}
                  />
                </Field>
                {initialInviteToken ? (
                  <MessageBar intent="success">
                    <MessageBarBody>
                      一次性邀请已读取。提交后需要等待主人明确批准。
                    </MessageBarBody>
                  </MessageBar>
                ) : (
                  <>
                    <Field label="新会话名称">
                      <Input
                        value={roomName}
                        maxLength={120}
                        onChange={(_, data) => setRoomName(data.value)}
                      />
                    </Field>
                    <div className="dialog-divider">
                      <span>或者</span>
                    </div>
                    <Field label="邀请令牌">
                      <Input
                        value={joinToken}
                        contentBefore={<KeyRegular />}
                        placeholder="cci_..."
                        onChange={(_, data) => setJoinToken(data.value)}
                      />
                    </Field>
                  </>
                )}
              </DialogContent>
              <DialogActions>
                {joinToken.trim() ? (
                  <Button
                    type="button"
                    appearance="primary"
                    disabled={!displayName.trim() || submitting}
                    onClick={() => void joinSession()}
                  >
                    申请加入
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    appearance="primary"
                    disabled={!displayName.trim() || !roomName.trim() || submitting}
                  >
                    创建会话
                  </Button>
                )}
              </DialogActions>
            </DialogBody>
          </form>
        </DialogSurface>
      </Dialog>

      <Dialog open={inviteOpen} onOpenChange={(_, data) => setInviteOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>邀请一位协作者</DialogTitle>
            <DialogContent className="setup-fields">
              <p className="dialog-intro">
                链接有效期 60 分钟，仅可使用一次。对方申请加入后仍需你的批准。
              </p>
              {isLoopbackOrigin() ? (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    当前链接仅能在这台电脑打开。邀请其他设备前，请从局域网地址或已部署的
                    HTTPS Relay 打开控制台。
                  </MessageBarBody>
                </MessageBar>
              ) : null}
              <Field label="一次性邀请链接">
                <Input
                  ref={inviteLinkRef}
                  value={inviteLink}
                  readOnly
                  onClick={(event) => event.currentTarget.select()}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </Field>
              {copied ? (
                <div className="copy-confirmation" aria-live="polite">
                  <CheckmarkCircleRegular />
                  邀请链接已复制
                </div>
              ) : null}
              {copyFailed ? (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>浏览器阻止了自动复制</MessageBarTitle>
                    链接已经选中，请按 Ctrl+C 复制。
                  </MessageBarBody>
                </MessageBar>
              ) : null}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setInviteOpen(false)}>
                关闭
              </Button>
              <Button
                appearance="primary"
                icon={<CopyRegular />}
                onClick={() => void copyInvite()}
              >
                {copied ? "已复制" : "复制邀请链接"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </FluentProvider>
  );
}

function connectionPresentation(
  state: ConnectionState,
  hasSession: boolean,
): { label: string; color: "success" | "warning" | "danger" | "informative" } {
  if (!hasSession) {
    return { label: "Relay 就绪", color: "informative" };
  }
  if (state === "live") {
    return { label: "实时连接", color: "success" };
  }
  if (state === "waiting") {
    return { label: "等待批准", color: "warning" };
  }
  if (state === "error") {
    return { label: "需要处理", color: "danger" };
  }
  return { label: "正在连接", color: "informative" };
}

function MemberSkeleton() {
  return (
    <Skeleton aria-label="正在加载成员">
      <div className="member-skeleton">
        <SkeletonItem shape="circle" size={32} />
        <div>
          <SkeletonItem size={12} />
          <SkeletonItem size={8} />
        </div>
      </div>
      <div className="member-skeleton">
        <SkeletonItem shape="circle" size={32} />
        <div>
          <SkeletonItem size={12} />
          <SkeletonItem size={8} />
        </div>
      </div>
    </Skeleton>
  );
}

function MessageSkeleton() {
  return (
    <Skeleton aria-label="正在加载消息">
      <div className="message-skeleton">
        <SkeletonItem size={8} />
        <SkeletonItem size={64} />
      </div>
      <div className="message-skeleton right">
        <SkeletonItem size={8} />
        <SkeletonItem size={56} />
      </div>
    </Skeleton>
  );
}
