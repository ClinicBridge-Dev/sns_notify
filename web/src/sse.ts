import { checkMe } from './api';
import type { SseMessageEvent, SseTranslationEvent, StatusDTO } from './types';

export interface EventHandlers {
  onMessage: (e: SseMessageEvent) => void;
  onTranslation: (e: SseTranslationEvent) => void;
  onStatus: (e: StatusDTO) => void;
  /** 연결이 끊겼다가 다시 열렸을 때 (놓친 이벤트를 메우기 위해 재조회) */
  onReconnect: () => void;
  /** 실시간 연결 상태 변화 (UI 표시용) */
  onConnectionChange: (connected: boolean) => void;
  /** 오류 후 /api/me 확인 결과 세션이 만료된 경우 */
  onUnauthorized: () => void;
}

function parse<T>(ev: Event): T | null {
  try {
    return JSON.parse((ev as MessageEvent).data) as T;
  } catch {
    return null;
  }
}

const PROBE_DELAY_MS = 2000;
const RECREATE_DELAY_MS = 5000;

/**
 * /api/events SSE 구독.
 * - 네트워크 오류: EventSource가 자동 재연결한다. 다시 열리면 onReconnect 호출.
 * - 401/5xx 응답: EventSource는 재연결을 포기(CLOSED)하고 401도 구분해 주지 않는다.
 *   그래서 오류 시 /api/me로 세션을 확인하고, 살아 있으면 직접 다시 연결한다.
 * 반환값은 연결 종료 함수.
 */
export function connectEvents(h: EventHandlers): () => void {
  let closed = false;
  let hadError = false;
  let es: EventSource | null = null;
  let timer: number | undefined;

  const schedule = (fn: () => void, ms: number) => {
    if (timer !== undefined) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      if (!closed) fn();
    }, ms);
  };

  const probe = async () => {
    let ok: boolean;
    try {
      ok = await checkMe();
    } catch {
      ok = true; // 서버 다운 등: 세션 문제는 아니므로 재연결을 계속 시도
    }
    if (closed) return;
    if (!ok) {
      close();
      h.onUnauthorized();
      return;
    }
    if (!es || es.readyState === EventSource.CLOSED) {
      schedule(open, RECREATE_DELAY_MS);
    }
  };

  function open() {
    es?.close();
    const src = new EventSource('/api/events', { withCredentials: true });
    es = src;

    src.addEventListener('open', () => {
      h.onConnectionChange(true);
      if (hadError) {
        hadError = false;
        h.onReconnect();
      }
    });

    src.addEventListener('error', () => {
      if (closed || es !== src) return;
      hadError = true;
      h.onConnectionChange(false);
      schedule(probe, PROBE_DELAY_MS);
    });

    src.addEventListener('message', (ev) => {
      const d = parse<SseMessageEvent>(ev);
      if (d && d.message && d.conversation) h.onMessage(d);
    });
    src.addEventListener('translation', (ev) => {
      const d = parse<SseTranslationEvent>(ev);
      if (d && d.translation) h.onTranslation(d);
    });
    src.addEventListener('status', (ev) => {
      const d = parse<StatusDTO>(ev);
      if (d && Array.isArray(d.accounts)) h.onStatus(d);
    });
  }

  function close() {
    closed = true;
    if (timer !== undefined) window.clearTimeout(timer);
    es?.close();
    es = null;
  }

  open();
  return close;
}
