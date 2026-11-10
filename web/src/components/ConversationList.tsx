import { fullDateTime, kindPlaceholder, listTime } from '../format';
import { isUnread, type ReadMap } from '../readState';
import type { ClientDTO, ConversationDTO, LastMessageDTO } from '../types';

interface Props {
  conversations: ConversationDTO[];
  clients: ClientDTO[];
  clientId: number | null;
  onClientChange: (id: number | null) => void;
  search: string;
  onSearchChange: (q: string) => void;
  selectedId: number | null;
  onSelect: (c: ConversationDTO) => void;
  readMap: ReadMap;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  now: Date;
}

function previewText(m: LastMessageDTO): string {
  const prefix = m.direction === 'outbound' ? '나: ' : '';
  let text: string;
  if (m.kind === 'text') text = m.body_preview;
  else if (m.kind === 'caption') text = m.body_preview || kindPlaceholder('caption')!;
  else text = m.body_preview || (kindPlaceholder(m.kind) ?? '');
  if (m.direction === 'system') return text;
  return prefix + text;
}

export default function ConversationList(p: Props) {
  return (
    <aside className="pane-list">
      <div className="list-filters">
        <select
          className="input select"
          aria-label="고객사 필터"
          value={p.clientId ?? ''}
          onChange={(e) => p.onClientChange(e.target.value === '' ? null : Number(e.target.value))}
        >
          <option value="">전체 고객사</option>
          {p.clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input
          className="input"
          type="search"
          placeholder="대화방 이름 검색"
          aria-label="대화방 이름 검색"
          value={p.search}
          onChange={(e) => p.onSearchChange(e.target.value)}
        />
      </div>

      <div className="list-body">
        {p.error && (
          <div className="list-msg error-text">
            {p.error}{' '}
            <button type="button" className="btn btn-sm" onClick={p.onRetry}>
              다시 시도
            </button>
          </div>
        )}
        {!p.error && p.loading && p.conversations.length === 0 && (
          <div className="list-msg muted">불러오는 중…</div>
        )}
        {!p.error && !p.loading && p.conversations.length === 0 && (
          <div className="list-msg muted">
            {p.search || p.clientId != null ? '조건에 맞는 대화가 없습니다.' : '대화가 없습니다.'}
          </div>
        )}
        <ul className={`conv-list ${p.loading && p.conversations.length > 0 ? 'is-stale' : ''}`}>
          {p.conversations.map((c) => {
            const unread = c.id !== p.selectedId && isUnread(p.readMap, c);
            const selected = c.id === p.selectedId;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  className={`conv-row ${selected ? 'is-selected' : ''} ${unread ? 'is-unread' : ''}`}
                  onClick={() => p.onSelect(c)}
                  aria-current={selected ? 'true' : undefined}
                >
                  <div className="conv-top">
                    <span className="conv-client">{c.client_name}</span>
                    <span className="conv-time" title={fullDateTime(c.last_activity_at)}>
                      {listTime(c.last_activity_at, p.now)}
                    </span>
                  </div>
                  <div className="conv-name">{c.display_name}</div>
                  <div className="conv-bottom">
                    <span className="conv-preview">
                      {c.last_message ? previewText(c.last_message) : <span className="muted">메시지 없음</span>}
                    </span>
                    {unread && <span className="unread-dot" aria-label="새 메시지" />}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
