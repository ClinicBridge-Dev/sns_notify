import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { UnauthorizedError, getMessages, isAbortError } from '../api';
import type { Bus } from '../bus';
import { formatDateLabel, messageDateKey } from '../format';
import type { ConversationDTO, MessageDTO } from '../types';
import MessageItem from './MessageItem';

interface Props {
  conversation: ConversationDTO;
  bus: Bus;
  onSeen: (conversationId: number, seq: number) => void;
}

const PAGE_SIZE = 50;
const BOTTOM_THRESHOLD_PX = 48;
const TOP_LOAD_THRESHOLD_PX = 120;

type ScrollIntent =
  | { type: 'bottom' }
  | { type: 'preserve'; prevHeight: number; prevTop: number }
  | null;

/** id 기준 중복 제거 후 seq 오름차순 정렬. incoming이 기존 값을 덮어쓴다. */
function mergeMessages(prev: MessageDTO[], incoming: MessageDTO[]): MessageDTO[] {
  if (incoming.length === 0) return prev;
  const map = new Map<number, MessageDTO>();
  for (const m of prev) map.set(m.id, m);
  for (const m of incoming) map.set(m.id, m);
  return Array.from(map.values()).sort((a, b) => a.seq - b.seq || a.id - b.id);
}

export default function ConversationView({ conversation, bus, onSeen }: Props) {
  const convId = conversation.id;
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const intentRef = useRef<ScrollIntent>(null);
  const loadingOlderRef = useRef(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  // 최신 페이지 로드
  useEffect(() => {
    const ac = new AbortController();
    setPhase('loading');
    getMessages(convId, { limit: PAGE_SIZE }, ac.signal)
      .then((page) => {
        intentRef.current = { type: 'bottom' };
        atBottomRef.current = true;
        setMessages((prev) => mergeMessages(prev, page.messages));
        setHasMore(page.has_more);
        setPhase('ready');
        const last = page.messages[page.messages.length - 1];
        if (last) onSeen(convId, last.seq);
      })
      .catch((e) => {
        if (isAbortError(e) || e instanceof UnauthorizedError) return;
        setPhase('error');
      });
    return () => ac.abort();
  }, [convId, reloadKey, onSeen]);

  // 렌더 직후 스크롤 위치 적용 (이전 페이지 추가 시 위치 유지 / 하단 고정)
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const intent = intentRef.current;
    if (!el || !intent) return;
    intentRef.current = null;
    if (intent.type === 'bottom') {
      el.scrollTop = el.scrollHeight;
      atBottomRef.current = true;
    } else {
      el.scrollTop = el.scrollHeight - intent.prevHeight + intent.prevTop;
    }
  }, [messages, phase]);

  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current || !hasMoreRef.current) return;
    const first = messagesRef.current[0];
    if (!first) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setOlderError(false);
    try {
      const page = await getMessages(convId, { before: first.seq, limit: PAGE_SIZE });
      if (unmountedRef.current) return;
      const el = scrollerRef.current;
      if (el && page.messages.length > 0) {
        intentRef.current = { type: 'preserve', prevHeight: el.scrollHeight, prevTop: el.scrollTop };
      }
      setMessages((prev) => mergeMessages(prev, page.messages));
      setHasMore(page.has_more);
    } catch (e) {
      if (!(e instanceof UnauthorizedError) && !unmountedRef.current) setOlderError(true);
    } finally {
      loadingOlderRef.current = false;
      if (!unmountedRef.current) setLoadingOlder(false);
    }
  }, [convId]);

  // 내용이 화면을 다 채우지 못하면 이전 메시지를 더 불러온다.
  useEffect(() => {
    const el = scrollerRef.current;
    if (phase !== 'ready' || !el || !hasMore || loadingOlder || olderError) return;
    if (el.scrollHeight <= el.clientHeight + TOP_LOAD_THRESHOLD_PX) void loadOlder();
  }, [messages, phase, hasMore, loadingOlder, olderError, loadOlder]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX;
    atBottomRef.current = atBottom;
    if (atBottom) setNewCount((n) => (n === 0 ? n : 0));
    if (el.scrollTop < TOP_LOAD_THRESHOLD_PX) void loadOlder();
  }, [loadOlder]);

  const scrollToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    atBottomRef.current = true;
    setNewCount(0);
  }, []);

  // 실시간 이벤트
  useEffect(() => {
    return bus.subscribe((ev) => {
      if (ev.type === 'message') {
        const m = ev.message;
        if (m.conversation_id !== convId) return;
        const isNew = !messagesRef.current.some((x) => x.id === m.id);
        if (atBottomRef.current) intentRef.current = { type: 'bottom' };
        else if (isNew) setNewCount((n) => n + 1);
        setMessages((prev) => mergeMessages(prev, [m]));
      } else if (ev.type === 'translation') {
        const t = ev.event;
        if (t.conversation_id !== convId) return;
        if (!messagesRef.current.some((m) => m.id === t.message_id)) return;
        // 번역이 붙어 말풍선이 길어져도 하단에 있던 사용자는 계속 하단에 머물게 한다.
        if (atBottomRef.current) intentRef.current = { type: 'bottom' };
        setMessages((prev) =>
          prev.map((m) => (m.id === t.message_id ? { ...m, translation: t.translation } : m)),
        );
      } else if (ev.type === 'resync') {
        getMessages(convId, { limit: PAGE_SIZE })
          .then((page) => {
            if (unmountedRef.current) return;
            const cur = messagesRef.current;
            const curMax = cur.length ? cur[cur.length - 1].seq : -Infinity;
            const newMin = page.messages.length ? page.messages[0].seq : Infinity;
            const wasAtBottom = atBottomRef.current;
            if (page.has_more && newMin > curMax && cur.length > 0) {
              // 끊긴 사이 메시지가 한 페이지보다 많음 → 구멍이 생기지 않게 최신 페이지로 교체
              intentRef.current = { type: 'bottom' };
              setMessages(page.messages);
              setHasMore(true);
              setNewCount(0);
              return;
            }
            const added = page.messages.filter((m) => !cur.some((x) => x.id === m.id)).length;
            if (wasAtBottom && page.messages.length > 0) intentRef.current = { type: 'bottom' };
            else if (added > 0) setNewCount((n) => n + added);
            setMessages((prev) => mergeMessages(prev, page.messages));
          })
          .catch(() => {});
      }
    });
  }, [bus, convId]);

  // 날짜 구분선 포함 렌더 목록
  let prevDate: string | null = null;
  const now = new Date();

  return (
    <section className="pane-chat">
      <div className="chat-header">
        <div className="chat-title">
          <span className="chat-client">{conversation.client_name}</span>
          <span className="chat-name">{conversation.display_name}</span>
        </div>
        <span className="readonly-tag" title="이 화면에서는 메시지를 보내거나 수정할 수 없습니다.">
          읽기 전용
        </span>
      </div>

      <div className="chat-scroll" ref={scrollerRef} onScroll={onScroll}>
        {phase === 'loading' && messages.length === 0 && <div className="chat-msg muted">불러오는 중…</div>}
        {phase === 'error' && (
          <div className="chat-msg error-text">
            메시지를 불러오지 못했습니다.{' '}
            <button type="button" className="btn btn-sm" onClick={() => setReloadKey((k) => k + 1)}>
              다시 시도
            </button>
          </div>
        )}
        {phase === 'ready' && (
          <div className="chat-top">
            {loadingOlder && <span className="muted">이전 메시지 불러오는 중…</span>}
            {!loadingOlder && olderError && (
              <button type="button" className="btn btn-sm" onClick={() => void loadOlder()}>
                이전 메시지 다시 불러오기
              </button>
            )}
            {!loadingOlder && !olderError && !hasMore && messages.length > 0 && (
              <span className="muted">대화의 처음입니다 (수집된 범위 기준)</span>
            )}
          </div>
        )}
        {phase === 'ready' && messages.length === 0 && <div className="chat-msg muted">메시지가 없습니다.</div>}

        {messages.map((m) => {
          const key = messageDateKey(m);
          const showSep = key !== prevDate;
          prevDate = key;
          return (
            <Fragment key={m.id}>
              {showSep && (
                <div className="date-sep">
                  <span>{formatDateLabel(key, now)}</span>
                </div>
              )}
              <MessageItem m={m} />
            </Fragment>
          );
        })}
      </div>

      {newCount > 0 && (
        <button type="button" className="new-pill" onClick={scrollToBottom}>
          새 메시지 {newCount}개 ↓
        </button>
      )}
    </section>
  );
}
