import { useCallback, useEffect, useRef, useState } from 'react';
import {
  UnauthorizedError,
  getClients,
  getConversations,
  getStatus,
  isAbortError,
  notifyUnauthorized,
} from '../api';
import { createBus } from '../bus';
import { getReadMap, markRead, seedIfFirstVisit, type ReadMap } from '../readState';
import { connectEvents } from '../sse';
import type { ClientDTO, ConversationDTO, SseMessageEvent, StatusDTO } from '../types';
import ConversationList from './ConversationList';
import ConversationView from './ConversationView';
import StatusBar from './StatusBar';

interface Props {
  onLogout: () => void;
}

const SEARCH_DEBOUNCE_MS = 300;

export default function Viewer({ onLogout }: Props) {
  const [status, setStatus] = useState<StatusDTO | null>(null);
  const [clients, setClients] = useState<ClientDTO[]>([]);
  const [conversations, setConversations] = useState<ConversationDTO[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [clientId, setClientId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState(''); // debounced search
  const [selected, setSelected] = useState<ConversationDTO | null>(null);
  const [readMap, setReadMap] = useState<ReadMap>(() => getReadMap());
  const [live, setLive] = useState<boolean | null>(null); // null = 최초 연결 중
  const [now, setNow] = useState(() => new Date());

  const busRef = useRef(createBus());
  const selectedIdRef = useRef<number | null>(null);
  selectedIdRef.current = selected?.id ?? null;
  const filterRef = useRef({ clientId, query });
  filterRef.current = { clientId, query };
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const listAbortRef = useRef<AbortController | null>(null);
  const refetchTimerRef = useRef<number | undefined>(undefined);

  // 상대 시각 갱신용 tick
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  // 검색어 디바운스
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [search]);

  const loadConversations = useCallback(async (opts: { quiet?: boolean } = {}) => {
    listAbortRef.current?.abort();
    const ac = new AbortController();
    listAbortRef.current = ac;
    const f = filterRef.current;
    if (!opts.quiet) setListLoading(true);
    try {
      const list = await getConversations({ clientId: f.clientId, q: f.query }, ac.signal);
      if (ac.signal.aborted) return;
      setConversations(list);
      setListError(null);
      if (f.clientId == null && !f.query) setReadMap(seedIfFirstVisit(list));
      // 열려 있는 대화의 헤더 정보 갱신
      const sel = selectedIdRef.current;
      if (sel != null) {
        const found = list.find((c) => c.id === sel);
        if (found) setSelected(found);
      }
    } catch (e) {
      if (isAbortError(e) || e instanceof UnauthorizedError) return;
      setListError('대화 목록을 불러오지 못했습니다.');
    } finally {
      if (listAbortRef.current === ac) setListLoading(false);
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await getStatus());
    } catch {
      // 상태 바는 다음 SSE status 이벤트로 갱신된다.
    }
  }, []);

  // 필터/검색 변경 시 목록 재조회
  useEffect(() => {
    void loadConversations();
  }, [clientId, query, loadConversations]);

  // 초기 1회: 고객사 목록, 상태
  useEffect(() => {
    getClients()
      .then(setClients)
      .catch(() => {});
    void loadStatus();
  }, [loadStatus]);

  const scheduleListRefetch = useCallback(() => {
    if (refetchTimerRef.current !== undefined) return;
    refetchTimerRef.current = window.setTimeout(() => {
      refetchTimerRef.current = undefined;
      void loadConversations({ quiet: true });
    }, 800);
  }, [loadConversations]);

  const handleSseMessage = useCallback(
    (d: SseMessageEvent) => {
      const conv = d.conversation;
      const f = filterRef.current;
      const inList = conversationsRef.current.some((c) => c.id === conv.id);
      // 목록에 없는 대화: 필터와 맞는지 확실할 때만 바로 추가, 아니면 서버에 다시 묻는다.
      const canInsert = !f.query && (f.clientId == null || f.clientId === conv.client_id);
      if (inList || canInsert) {
        setConversations((prev) => [conv, ...prev.filter((c) => c.id !== conv.id)]);
      } else if (f.query) {
        scheduleListRefetch();
      }
      if (selectedIdRef.current === conv.id) {
        setSelected(conv);
        setReadMap(markRead(conv.id, Math.max(conv.last_seq, d.message.seq)));
      }
      busRef.current.emit({ type: 'message', message: d.message });
    },
    [scheduleListRefetch],
  );

  // SSE 구독
  useEffect(() => {
    const close = connectEvents({
      onMessage: handleSseMessage,
      onTranslation: (event) => busRef.current.emit({ type: 'translation', event }),
      onStatus: setStatus,
      onReconnect: () => {
        void loadConversations({ quiet: true });
        void loadStatus();
        busRef.current.emit({ type: 'resync' });
      },
      onConnectionChange: setLive,
      onUnauthorized: notifyUnauthorized,
    });
    return () => {
      close();
      if (refetchTimerRef.current !== undefined) window.clearTimeout(refetchTimerRef.current);
    };
  }, [handleSseMessage, loadConversations, loadStatus]);

  const openConversation = useCallback((c: ConversationDTO) => {
    setSelected(c);
    setReadMap(markRead(c.id, c.last_seq));
  }, []);

  const handleSeen = useCallback((conversationId: number, seq: number) => {
    setReadMap(markRead(conversationId, seq));
  }, []);

  return (
    <div className="app">
      <StatusBar status={status} live={live} now={now} onLogout={onLogout} />
      <div className="main">
        <ConversationList
          conversations={conversations}
          clients={clients}
          clientId={clientId}
          onClientChange={setClientId}
          search={search}
          onSearchChange={setSearch}
          selectedId={selected?.id ?? null}
          onSelect={openConversation}
          readMap={readMap}
          loading={listLoading}
          error={listError}
          onRetry={() => void loadConversations()}
          now={now}
        />
        {selected ? (
          <ConversationView
            key={selected.id}
            conversation={selected}
            bus={busRef.current}
            onSeen={handleSeen}
          />
        ) : (
          <section className="pane-chat empty-state">
            <div className="empty-inner">
              <div className="empty-title">대화를 선택하세요</div>
              <div className="empty-sub">왼쪽 목록에서 고객 대화를 선택하면 내용이 표시됩니다.</div>
              <div className="empty-sub muted">이 화면은 읽기 전용입니다.</div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
