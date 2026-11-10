import threading

from app.main import watch_parent


def test_exits_when_launcher_app_disappears(monkeypatch):
    ppids = iter([4242, 4242, 1])
    monkeypatch.setattr("os.getppid", lambda: next(ppids, 1))
    exited = threading.Event()
    watch_parent(4242, interval=0.01, exit_fn=lambda code: exited.set())
    assert exited.wait(2)
