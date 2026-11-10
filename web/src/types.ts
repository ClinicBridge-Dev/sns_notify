// 백엔드 API 계약 (docs/etc/2026-11-09-impl-plan.md §6 + 프론트 작업 지시)

export type Direction = 'inbound' | 'outbound' | 'unknown' | 'system';
export type Kind = 'text' | 'caption' | 'attachment' | 'voice' | 'sticker' | 'other';
export type TimePrecision = 'exact' | 'minute' | 'date_only' | 'unknown';
export type CollectMode = 'baseline' | 'live' | 'catchup';
export type Confidence = 'high' | 'review';
export type TranslationStatus = 'not_needed' | 'pending' | 'done' | 'failed' | 'retry';
export type AccountStatus = 'ok' | 'disconnected' | 'locked' | 'unknown';

export interface TranslationDTO {
  lang: string;
  status: TranslationStatus;
  ko_text: string | null;
}

export interface MessageDTO {
  id: number;
  conversation_id: number;
  seq: number;
  direction: Direction;
  kind: Kind;
  body: string | null;
  sender_hint: string | null;
  /** e.g. "사진", "PDF" when the reader could tell */
  attachment_label?: string | null;
  /** "HH:MM" */
  shown_time: string | null;
  /** "YYYY-MM-DD" when known, else raw label or null */
  shown_date_hint: string | null;
  time_precision: TimePrecision;
  /** UTC ISO */
  observed_at: string;
  collect_mode: CollectMode;
  confidence: Confidence;
  translation: TranslationDTO | null;
}

export interface LastMessageDTO {
  body_preview: string;
  direction: Direction;
  kind: Kind;
  shown_time: string | null;
}

export interface ConversationDTO {
  id: number;
  client_id: number;
  client_name: string;
  display_name: string;
  last_message: LastMessageDTO | null;
  last_activity_at: string | null;
  last_seq: number;
}

export interface ClientDTO {
  id: number;
  name: string;
}

export interface AccountDTO {
  id: number;
  label: string;
  client_name: string;
  status: AccountStatus;
  last_ok_at: string | null;
}

export interface InstagramStatus {
  account: string;
  unread_total: number;
  updated_at: string;
}

export interface StatusDTO {
  accounts: AccountDTO[];
  /** Instagram DM "new message" watch (Chrome extension); absent on older servers */
  instagram?: InstagramStatus[];
  translation_pending: number;
  slack: { pending: number; failed: number; unconfirmed: number };
  server_time: string;
}

export interface MessagesPage {
  messages: MessageDTO[];
  has_more: boolean;
}

// SSE payloads
export interface SseMessageEvent {
  message: MessageDTO;
  conversation: ConversationDTO;
}

export interface SseTranslationEvent {
  message_id: number;
  conversation_id: number;
  translation: TranslationDTO;
}

export type LoginResult =
  | { ok: true }
  | { ok: false; error: 'invalid_password' | 'too_many_attempts' | 'network' | 'unknown' };
