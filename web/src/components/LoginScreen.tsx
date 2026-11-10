import { useState, type FormEvent } from 'react';
import { login } from '../api';

const ERROR_TEXT = {
  invalid_password: '비밀번호가 올바르지 않습니다.',
  too_many_attempts: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.',
  network: '서버에 연결할 수 없습니다. 네트워크를 확인해 주세요.',
  unknown: '로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.',
} as const;

interface Props {
  notice: string | null;
  onLoggedIn: () => void;
}

export default function LoginScreen({ notice, onLoggedIn }: Props) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    const res = await login(password);
    setBusy(false);
    if (res.ok) {
      setPassword('');
      onLoggedIn();
    } else {
      setError(ERROR_TEXT[res.error]);
      if (res.error === 'invalid_password') setPassword('');
    }
  }

  return (
    <div className="center-screen login-bg">
      <form className="login-card" onSubmit={submit}>
        <h1 className="login-title">WhatsApp 대화 뷰어</h1>
        <p className="login-sub">읽기 전용 · 사내 전용</p>
        {notice && !error && <div className="login-notice">{notice}</div>}
        <label className="login-label" htmlFor="pw">
          비밀번호
        </label>
        <input
          id="pw"
          className="input"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
        {error && (
          <div className="login-error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" className="btn btn-primary login-btn" disabled={busy || !password}>
          {busy ? '확인 중…' : '로그인'}
        </button>
      </form>
    </div>
  );
}
