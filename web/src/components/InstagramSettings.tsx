import { useCallback, useEffect, useState } from 'react';
import {
  getInstagramAccounts, getSlackChannels, saveInstagramRoute, isAbortError, UnauthorizedError,
  type InstagramAccount, type SlackChannel, type SlackChannels,
} from '../api';

const destinationKey = (ref: string | null, id: string | null) => ref && id ? `${ref}:${id}` : '';
const date = (value: string) => new Date(value).toLocaleString('ko-KR');
const delivery: Record<string, string> = {
  sent: 'Slack 게시 완료', skipped: '전송 생략', pending: '전송 대기', retry: '재시도 대기',
  failed: '전송 실패', unconfirmed: '게시 여부 확인 필요',
};

function AccountCard({ account, channels, onSaved }: {
  account: InstagramAccount; channels: SlackChannel[]; onSaved: () => Promise<void>;
}) {
  const current = destinationKey(account.token_ref, account.channel_id);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const selected = draft ?? (account.state === 'unmapped' ? '__unmapped' : current);
  const dirty = draft !== null && (draft !== current || account.state === 'unmapped');
  const available = channels.some(c => destinationKey(c.token_ref, c.id) === current);
  const last = account.folders.reduce((best, f) => f.snapshot_at > best ? f.snapshot_at : best, '');
  const live = last && Date.now() - Date.parse(last) < 180000;
  const states = { connected: '연결됨', unmapped: '채널 미설정', paused: '알림 중지', inactive: '연결 비활성' };

  async function save() {
    const channel = channels.find(c => destinationKey(c.token_ref, c.id) === selected) ?? null;
    if (selected && !channel) return;
    setSaving(true); setError(''); setMessage('');
    try {
      await saveInstagramRoute(account.account, channel);
      await onSaved();
      setDraft(null);
      setMessage(channel ? '저장했습니다. 다음 새 메시지부터 적용됩니다.' : '이 계정의 새 알림을 중지했습니다.');
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) setError(e instanceof Error ? e.message : '저장하지 못했습니다.');
    } finally { setSaving(false); }
  }

  return <article className="routing-card">
    <div className="routing-card-head">
      <h2>@{account.account}</h2>
      <span className={`chip chip-${account.state === 'connected' ? 'ok' : 'warn'}`}>{states[account.state]}</span>
    </div>
    <p className={live ? 'routing-live' : 'muted'}>
      {live ? '수집 중' : last ? '최근 수집 없음' : '아직 수집되지 않음'}
      {last ? ` · 마지막 수집 ${date(last)}` : ''}
    </p>
    <div className="routing-folders">
      {(['primary', 'general', 'requests'] as const).map(folder => {
        const f = account.folders.find(item => item.folder === folder);
        return <span key={folder} title={f ? date(f.snapshot_at) : '이 목록을 별도 Chrome 창에서 열어 주세요'}>
          {{ primary: 'Primary', general: 'General', requests: '요청' }[folder]}
          {!f ? ' · 미수집' : Date.now() - Date.parse(f.snapshot_at) > 180000 ? ' · 중단' : ' · 수신 중'}
        </span>;
      })}
    </div>
    <label htmlFor={`channel-${account.account}`}>알림을 받을 Slack 채널</label>
    <div className="routing-controls">
      <select id={`channel-${account.account}`} className="input select" value={selected} disabled={saving}
        onChange={e => { setDraft(e.target.value); setMessage(''); setError(''); }}>
        {account.state === 'unmapped' && draft === null ? <option value="__unmapped" disabled>채널을 선택해 주세요</option> : null}
        <option value="">알림 중지</option>
        {current && !available ? <option value={current} disabled>현재 연결: {account.destination_name} ({account.channel_id}) · 채널 조회 필요</option> : null}
        {channels.map(c => <option key={destinationKey(c.token_ref, c.id)} value={destinationKey(c.token_ref, c.id)}>
          {c.workspace} / #{c.name}{c.private ? ' (비공개)' : ''}
        </option>)}
      </select>
      <button type="button" className="btn btn-primary" disabled={!dirty || saving || Boolean(selected && !channels.some(c => destinationKey(c.token_ref, c.id) === selected))}
        onClick={() => void save()}>{saving ? '저장 중…' : '저장'}</button>
    </div>
    {account.latest_notice ? <p className="muted routing-delivery">
      최근 알림: {delivery[account.latest_notice.slack_status] || account.latest_notice.slack_status} · {date(account.latest_notice.created_at)}
      {account.latest_notice.last_error ? ` · ${account.latest_notice.last_error}` : ''}
    </p> : <p className="muted routing-delivery">아직 생성된 알림이 없습니다.</p>}
    {message ? <p className="routing-live" role="status">{message}</p> : null}
    {error ? <p className="error-text" role="alert">{error}</p> : null}
  </article>;
}

export default function InstagramSettings({ onLogout }: { onLogout: () => void }) {
  const [accounts, setAccounts] = useState<InstagramAccount[]>([]);
  const [catalog, setCatalog] = useState<SlackChannels>({ channels: [], errors: [] });
  const [loading, setLoading] = useState(true);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [accountError, setAccountError] = useState('');
  const [channelError, setChannelError] = useState('');

  const refreshAccounts = useCallback(async (signal?: AbortSignal) => {
    const data = await getInstagramAccounts(signal);
    setAccounts(data.accounts); setAccountError('');
  }, []);
  const refreshChannels = useCallback(async (signal?: AbortSignal) => {
    setChannelsLoading(true);
    try { setCatalog(await getSlackChannels(signal)); setChannelError(''); }
    catch (e) { if (!isAbortError(e) && !(e instanceof UnauthorizedError)) setChannelError('Slack 채널을 불러오지 못했습니다. 다시 시도해 주세요.'); }
    finally { if (!signal?.aborted) setChannelsLoading(false); }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      try { await refreshAccounts(ac.signal); }
      catch (e) { if (!isAbortError(e) && !(e instanceof UnauthorizedError)) setAccountError('계정 목록을 불러오지 못했습니다. 연결을 확인해 주세요.'); }
      finally {
        if (!ac.signal.aborted) { setLoading(false); timer = window.setTimeout(() => void poll(), 10000); }
      }
    };
    void poll();
    void refreshChannels(ac.signal);
    return () => { ac.abort(); window.clearTimeout(timer); };
  }, [refreshAccounts, refreshChannels]);

  return <div className="routing-page">
    <header className="routing-header"><a href="/">← 대화 뷰어</a><button type="button" className="btn" onClick={onLogout}>로그아웃</button></header>
    <main className="routing-main">
      <div className="routing-title"><div><p className="routing-eyebrow">INSTAGRAM → SLACK</p><h1>알림 계정 관리</h1></div>
        <button type="button" className="btn" disabled={channelsLoading} onClick={() => void refreshChannels()}>{channelsLoading ? '채널 조회 중…' : 'Slack 채널 새로고침'}</button>
      </div>
      <p className="routing-intro">인스타그램에서 계정을 전환하고 DM 목록을 열면 이곳에 자동으로 나타납니다. 계정별 Slack 채널을 선택하고 저장하세요.</p>
      <div className="routing-help">저장 즉시 적용되며 서버 재시작은 필요 없습니다. 새로 감지된 계정은 채널을 연결하기 전까지 알림을 보내지 않습니다. 기존에 생성된 알림은 변경하거나 다시 보내지 않습니다.</div>
      {accountError ? <p className="error-text" role="alert">{accountError}</p> : null}
      {channelError ? <p className="error-text" role="alert">{channelError}</p> : null}
      {catalog.errors.map(e => <p className="error-text" role="alert" key={e.token_ref}>{e.message}</p>)}
      {!channelsLoading && !catalog.channels.length ? <p className="routing-help">선택할 수 있는 채널이 없습니다. 사용할 Slack 채널에 봇을 추가하고 채널 새로고침을 눌러 주세요.</p> : null}
      {loading ? <p role="status">계정을 불러오는 중…</p> : accounts.length ? <div className="routing-grid">
        {accounts.map(account => <AccountCard key={account.account} account={account} channels={catalog.channels} onSaved={refreshAccounts} />)}
      </div> : <div className="routing-card"><h2>아직 감지된 계정이 없습니다</h2><p>익스텐션을 설치한 Chrome에서 인스타그램 DM 목록을 열어 주세요. 목록은 10초마다 갱신됩니다.</p></div>}
      <p className="muted">Primary · General · 요청을 모두 감시하려면 같은 계정으로 Chrome 창을 3개 열고 각 목록을 하나씩 유지해 주세요. 열리지 않은 목록은 수집할 수 없습니다. 대화방을 열면 읽음 처리될 수 있습니다.</p>
    </main>
  </div>;
}
