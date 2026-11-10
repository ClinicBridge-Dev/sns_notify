import type { Kind, MessageDTO } from './types';

/** text/caption 이외 kind의 자리표시. (attachment에는 세부 유형 정보가 없어 "[첨부]"로 통일) */
export function kindPlaceholder(kind: Kind): string | null {
  switch (kind) {
    case 'attachment':
      return '[첨부]';
    case 'voice':
      return '[음성 메시지]';
    case 'sticker':
      return '[스티커]';
    case 'other':
      return '[기타 메시지]';
    case 'caption':
      return '[첨부]';
    default:
      return null;
  }
}

/** 말풍선에 보일 본문. text/caption은 body, 그 외는 자리표시. */
export function messageBodyText(m: Pick<MessageDTO, 'kind' | 'body' | 'attachment_label'>): string {
  const label = m.attachment_label?.trim();
  if (m.kind === 'text') return m.body ?? '';
  if (m.kind === 'caption') return m.body ? m.body : label ? `[첨부: ${label}]` : kindPlaceholder('caption')!;
  if (m.kind === 'attachment' && label) return `[첨부: ${label}]`;
  return kindPlaceholder(m.kind) ?? '';
}

const pad = (n: number) => String(n).padStart(2, '0');

function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 날짜 구분선용 키: shown_date_hint가 YYYY-MM-DD면 사용, 아니면 observed_at 로컬 날짜. */
export function messageDateKey(m: MessageDTO): string {
  if (m.shown_date_hint && ISO_DATE_RE.test(m.shown_date_hint)) return m.shown_date_hint;
  const d = parseDate(m.observed_at);
  return d ? localDateKey(d) : '';
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** "2026년 11월 9일 (월)" + 오늘/어제 표시 */
export function formatDateLabel(key: string, now: Date = new Date()): string {
  if (!ISO_DATE_RE.test(key)) return key || '날짜 미상';
  const [y, mo, d] = key.split('-').map(Number);
  const date = new Date(y, mo - 1, d);
  const base = `${y}년 ${mo}월 ${d}일 (${WEEKDAYS[date.getDay()]})`;
  const today = localDateKey(now);
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (key === today) return `오늘 · ${base}`;
  if (key === localDateKey(yest)) return `어제 · ${base}`;
  return base;
}

export function clockOf(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 말풍선 아래 시각. shown_time 우선, 없으면 observed_at(수집 시각) 로컬 HH:MM.
 * fromObserved=true면 화면 표시 시각이 아니라 수집 시각임을 뜻한다.
 */
export function messageTime(m: MessageDTO): { text: string; fromObserved: boolean } {
  if (m.shown_time) return { text: m.shown_time, fromObserved: false };
  const d = parseDate(m.observed_at);
  return { text: d ? clockOf(d) : '', fromObserved: true };
}

/** "방금", "2분 전", "3시간 전", "어제", "11/2" */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  const d = parseDate(iso);
  if (!d) return '-';
  const diff = Math.max(0, now.getTime() - d.getTime());
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return '방금';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}일 전`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 대화 목록용 시각: 오늘이면 HH:MM, 어제면 "어제", 올해면 M/D, 아니면 YYYY.M.D */
export function listTime(iso: string | null | undefined, now: Date = new Date()): string {
  const d = parseDate(iso);
  if (!d) return '';
  const key = localDateKey(d);
  if (key === localDateKey(now)) return clockOf(d);
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (key === localDateKey(yest)) return '어제';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
}

export function fullDateTime(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return '';
  return `${localDateKey(d)} ${clockOf(d)}:${pad(d.getSeconds())}`;
}
