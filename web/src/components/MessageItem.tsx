import { memo } from 'react';
import { fullDateTime, messageBodyText, messageTime } from '../format';
import type { MessageDTO } from '../types';

const PRECISION_LABEL: Record<MessageDTO['time_precision'], string> = {
  exact: '정확',
  minute: '분 단위',
  date_only: '날짜만',
  unknown: '알 수 없음',
};

function Badges({ m }: { m: MessageDTO }) {
  const t = m.translation;
  return (
    <>
      {m.direction === 'unknown' && <span className="badge badge-gray">방향 미확인</span>}
      {m.collect_mode === 'catchup' && (
        <span className="badge badge-amber" title="실시간이 아니라 나중에 수집된 메시지">
          지연 수집
        </span>
      )}
      {m.confidence === 'review' && (
        <span className="badge badge-amber" title="방향·시각·인용 여부 등 수집 결과 확인 필요">
          확인 필요
        </span>
      )}
      {t && (t.status === 'pending' || t.status === 'retry') && (
        <span className="badge badge-blue">번역 중</span>
      )}
      {t && t.status === 'failed' && <span className="badge badge-red">번역 실패</span>}
    </>
  );
}

function MessageItem({ m }: { m: MessageDTO }) {
  const time = messageTime(m);
  const timeTitle =
    `수집 시각: ${fullDateTime(m.observed_at)}` +
    `\n시각 정밀도: ${PRECISION_LABEL[m.time_precision]}` +
    (time.fromObserved ? '\n(화면 표시 시각이 없어 수집 시각을 표시)' : '') +
    (m.shown_date_hint ? `\n날짜 표시: ${m.shown_date_hint}` : '');
  const body = messageBodyText(m);
  const isPlaceholder = !(m.kind === 'text' || (m.kind === 'caption' && m.body));

  if (m.direction === 'system') {
    return (
      <div className="msg-system" title={timeTitle}>
        <span className="msg-system-line" />
        <span className="msg-system-text">
          {body || '안내'}
          {(m.collect_mode === 'catchup' || m.confidence === 'review') && (
            <span className="msg-system-badges">
              <Badges m={m} />
            </span>
          )}
        </span>
        <span className="msg-system-line" />
      </div>
    );
  }

  const side = m.direction === 'inbound' ? 'in' : m.direction === 'outbound' ? 'out' : 'unknown';
  const ko = m.translation?.status === 'done' && m.translation.ko_text ? m.translation.ko_text : null;

  return (
    <div className={`msg-row msg-${side}`} data-seq={m.seq}>
      <div className="msg-col">
        {m.sender_hint && side !== 'out' && <div className="msg-sender">{m.sender_hint}</div>}
        <div className="bubble">
          <div className={`bubble-body ${isPlaceholder ? 'is-placeholder' : ''}`}>{body}</div>
          {ko && (
            <div className="bubble-ko" lang="ko">
              <span className="ko-label">번역</span>
              {ko}
            </div>
          )}
        </div>
        <div className="msg-meta">
          <Badges m={m} />
          <span className={`msg-time ${time.fromObserved ? 'is-observed' : ''}`} title={timeTitle}>
            {time.fromObserved && time.text ? `수집 ${time.text}` : time.text}
          </span>
        </div>
      </div>
    </div>
  );
}

export default memo(MessageItem);
