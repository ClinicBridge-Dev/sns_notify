import { fullDateTime, relativeTime } from '../format';
import type { AccountStatus, StatusDTO } from '../types';

const ACCOUNT_LABEL: Record<AccountStatus, string> = {
  ok: '연결됨',
  disconnected: '연결 끊김',
  locked: '화면 잠김',
  unknown: '확인 불가',
};

const ACCOUNT_TONE: Record<AccountStatus, 'ok' | 'bad' | 'warn'> = {
  ok: 'ok',
  disconnected: 'bad',
  locked: 'warn',
  unknown: 'warn',
};

interface Props {
  status: StatusDTO | null;
  live: boolean | null;
  now: Date;
  onLogout: () => void;
}

function latest(isos: (string | null)[]): string | null {
  let best: string | null = null;
  let bestT = -Infinity;
  for (const s of isos) {
    if (!s) continue;
    const t = new Date(s).getTime();
    if (!Number.isNaN(t) && t > bestT) {
      bestT = t;
      best = s;
    }
  }
  return best;
}

export default function StatusBar({ status, live, now, onLogout }: Props) {
  const lastCollected = status ? latest(status.accounts.map((a) => a.last_ok_at)) : null;
  const slack = status?.slack;

  return (
    <header className="statusbar">
      <div className="sb-brand">WhatsApp 대화 뷰어</div>

      <div className="sb-group sb-accounts">
        {status === null && <span className="muted">상태 확인 중…</span>}
        {status && status.accounts.length === 0 && <span className="muted">등록된 계정 없음</span>}
        {status?.accounts.map((a) => (
          <span
            key={a.id}
            className={`chip chip-${ACCOUNT_TONE[a.status]}`}
            title={`${a.client_name} · ${a.label}\n상태: ${ACCOUNT_LABEL[a.status]}\n마지막 정상 수집: ${
              a.last_ok_at ? fullDateTime(a.last_ok_at) : '없음'
            }`}
          >
            <span className="chip-dot" aria-hidden="true" />
            <span className="chip-name">{a.label}</span>
            <span className="chip-state">{ACCOUNT_LABEL[a.status]}</span>
          </span>
        ))}
      </div>

      {status && (
        <div className="sb-group sb-metrics">
          <span className="metric" title={lastCollected ? fullDateTime(lastCollected) : undefined}>
            <span className="metric-label">마지막 수집</span>
            <span className="metric-value">{lastCollected ? relativeTime(lastCollected, now) : '없음'}</span>
          </span>
          <span className={`metric ${status.translation_pending > 0 ? 'metric-info' : ''}`}>
            <span className="metric-label">번역 대기</span>
            <span className="metric-value">{status.translation_pending}</span>
          </span>
          {status.instagram?.map((ig) => {
            // the extension reports at least once a minute; older than 3 minutes means the tab is closed
            const stale = now.getTime() - new Date(ig.updated_at).getTime() > 3 * 60 * 1000;
            return (
              <span
                key={ig.account}
                className={`metric ${stale ? 'metric-warn' : ig.unread_total > 0 ? 'metric-alert' : ''}`}
                title={`인스타그램 ${ig.account}\n마지막 확인: ${fullDateTime(ig.updated_at)}${
                  stale ? '\n3분 넘게 확인되지 않음 — Chrome의 인스타그램 DM 탭이 열려 있는지 확인하세요' : ''
                }`}
              >
                <span className="metric-label">Instagram {ig.account}</span>
                <span className="metric-value">{stale ? '확인 안 됨' : `안 읽음 ${ig.unread_total}`}</span>
              </span>
            );
          })}
          {slack && (
            <span className="metric metric-slack">
              <span className="metric-label">Slack</span>
              <span className="metric-sub">
                대기 <b>{slack.pending}</b>
              </span>
              <span className={`metric-sub ${slack.failed > 0 ? 'metric-alert' : ''}`}>
                실패 <b>{slack.failed}</b>
              </span>
              <span className={`metric-sub ${slack.unconfirmed > 0 ? 'metric-warn' : ''}`}>
                미확인 <b>{slack.unconfirmed}</b>
              </span>
            </span>
          )}
        </div>
      )}

      <div className="sb-right">
        <span
          className={`live ${live === null ? 'live-wait' : live ? 'live-on' : 'live-off'}`}
          title={
            live === null ? '실시간 갱신 연결 중' : live ? '실시간 갱신 연결됨' : '실시간 갱신 끊김 · 재연결 중'
          }
        >
          <span className="live-dot" aria-hidden="true" />
          {live === null ? '연결 중' : live ? '실시간' : '재연결 중'}
        </span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onLogout}>
          로그아웃
        </button>
      </div>
    </header>
  );
}
