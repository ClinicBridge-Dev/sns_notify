import pytest

from app.db.repo import connect, migrate


@pytest.fixture
def db(tmp_path):
    path = tmp_path / "t.db"
    conn = connect(path)
    migrate(conn)
    yield conn
    conn.close()


@pytest.fixture
def db_path(tmp_path):
    path = tmp_path / "t.db"
    c = connect(path)
    migrate(c)
    c.close()
    return path
