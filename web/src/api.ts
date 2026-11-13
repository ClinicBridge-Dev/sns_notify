import type {
  ClientDTO,
  ConversationDTO,
  LoginResult,
  MessagesPage,
  StatusDTO,
} from './types';

/** 세션 만료 등으로 401을 받았을 때 던진다. App이 로그인 화면으로 전환한다. */
export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized');
    this.name = 'UnauthorizedError';
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

let onUnauthorized: (() => void) | null = null;

/** 401 수신 시 호출될 전역 핸들러 (App에서 등록). */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

/** 세션 만료를 App에 알린다 (SSE 등 fetch 외 경로용). */
export function notifyUnauthorized(): void {
  onUnauthorized?.();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) {
    onUnauthorized?.();
    throw new UnauthorizedError();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, typeof body?.detail === 'string' ? body.detail : `${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** 로그인 여부 확인. 401이면 false (전역 핸들러는 호출하지 않음). */
export async function checkMe(): Promise<boolean> {
  const res = await fetch('/api/me', { credentials: 'same-origin' });
  if (res.status === 401) return false;
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
  return true;
}

/** 로그인. 여기서의 401은 세션 만료가 아니라 비밀번호 오류다. */
export async function login(password: string): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password }),
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  if (res.ok) return { ok: true };
  if (res.status === 401) return { ok: false, error: 'invalid_password' };
  if (res.status === 429) return { ok: false, error: 'too_many_attempts' };
  return { ok: false, error: 'unknown' };
}

export async function logout(): Promise<void> {
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    // 네트워크 오류여도 화면은 로그인으로 돌린다.
  }
}

export function getStatus(): Promise<StatusDTO> {
  return request<StatusDTO>('/api/status');
}

export function getClients(): Promise<ClientDTO[]> {
  return request<ClientDTO[]>('/api/clients');
}

export function getConversations(
  params: { clientId?: number | null; q?: string },
  signal?: AbortSignal,
): Promise<ConversationDTO[]> {
  const sp = new URLSearchParams();
  if (params.clientId != null) sp.set('client_id', String(params.clientId));
  const q = params.q?.trim();
  if (q) sp.set('q', q);
  const qs = sp.toString();
  return request<ConversationDTO[]>(`/api/conversations${qs ? `?${qs}` : ''}`, { signal });
}

export function getMessages(
  conversationId: number,
  opts: { before?: number; limit?: number } = {},
  signal?: AbortSignal,
): Promise<MessagesPage> {
  const sp = new URLSearchParams();
  if (opts.before != null) sp.set('before', String(opts.before));
  sp.set('limit', String(opts.limit ?? 50));
  return request<MessagesPage>(`/api/conversations/${conversationId}/messages?${sp}`, { signal });
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

export interface InstagramAccount {
  account: string;
  state: 'connected' | 'unmapped' | 'paused' | 'inactive';
  channel_id: string | null;
  token_ref: string | null;
  destination_name: string | null;
  folders: { folder: string; snapshot_at: string }[];
  latest_notice: { created_at: string; slack_status: string; last_error: string | null } | null;
}
export interface SlackChannel {
  id: string;
  name: string;
  private: boolean;
  token_ref: string;
  workspace: string;
}
export interface SlackChannels {
  channels: SlackChannel[];
  errors: { token_ref: string; message: string }[];
}
export function getInstagramAccounts(signal?: AbortSignal) {
  return request<{ accounts: InstagramAccount[] }>('/api/manage/instagram', { signal });
}
export function getSlackChannels(signal?: AbortSignal) {
  return request<SlackChannels>('/api/manage/slack-channels', { signal });
}
export function saveInstagramRoute(account: string, channel: SlackChannel | null) {
  return request<{ ok: boolean }>(`/api/manage/instagram/${encodeURIComponent(account)}`, {
    method: 'PUT',
    headers: { 'X-Requested-With': 'sns-notify' },
    body: JSON.stringify({ channel_id: channel?.id ?? null, token_ref: channel?.token_ref ?? null }),
  });
}
