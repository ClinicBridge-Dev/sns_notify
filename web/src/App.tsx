import { useCallback, useEffect, useRef, useState } from 'react';
import { checkMe, logout, setUnauthorizedHandler } from './api';
import LoginScreen from './components/LoginScreen';
import Viewer from './components/Viewer';

type AuthState = 'checking' | 'login' | 'authed' | 'offline';

export default function App() {
  const [auth, setAuth] = useState<AuthState>('checking');
  const [expired, setExpired] = useState(false);
  const authRef = useRef<AuthState>(auth);
  authRef.current = auth;

  const check = useCallback(async () => {
    setAuth('checking');
    try {
      setAuth((await checkMe()) ? 'authed' : 'login');
    } catch {
      setAuth('offline');
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (authRef.current === 'authed') setExpired(true);
      setAuth('login');
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const handleLogout = useCallback(async () => {
    await logout();
    setExpired(false);
    setAuth('login');
  }, []);

  if (auth === 'checking') {
    return <div className="center-screen muted">불러오는 중…</div>;
  }
  if (auth === 'offline') {
    return (
      <div className="center-screen">
        <div className="offline-box">
          <p>서버에 연결할 수 없습니다.</p>
          <button type="button" className="btn" onClick={() => void check()}>
            다시 시도
          </button>
        </div>
      </div>
    );
  }
  if (auth === 'login') {
    return (
      <LoginScreen
        notice={expired ? '세션이 만료되었습니다. 다시 로그인해 주세요.' : null}
        onLoggedIn={() => {
          setExpired(false);
          setAuth('authed');
        }}
      />
    );
  }
  return <Viewer onLogout={handleLogout} />;
}
