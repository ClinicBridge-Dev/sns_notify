from app.collector.contract import ObservedMessage as M
from app.collector.fingerprint import align_new, content_key, fingerprint


def m(body, d="inbound", t="10:00", ext=None):
    return M(direction=d, kind="text", body=body, shown_time=t, external_id=ext)


def keys(ms):
    return [content_key(x) for x in ms]


def test_no_stored_all_new():
    w = [m("a"), m("b")]
    r = align_new([], w)
    assert r.new == w and r.overlap == 0 and not r.ambiguous


def test_simple_tail_overlap():
    w = [m("a"), m("b"), m("c")]
    r = align_new(keys([m("a"), m("b")]), w)
    assert [x.body for x in r.new] == ["c"] and r.overlap == 2


def test_nothing_new():
    w = [m("a"), m("b")]
    r = align_new(keys(w), w)
    assert r.new == [] and r.overlap == 2


def test_two_identical_ne_same_minute_are_kept():
    stored = keys([m("안녕"), m("네")])
    w = [m("안녕"), m("네"), m("네")]
    r = align_new(stored, w)
    assert [x.body for x in r.new] == ["네"]


def test_window_starts_after_stored_start():
    stored = keys([m("x"), m("y"), m("a"), m("b")])
    w = [m("a"), m("b"), m("c"), m("d")]
    r = align_new(stored, w)
    assert [x.body for x in r.new] == ["c", "d"]


def test_no_overlap_reports_gap():
    stored = keys([m("old")])
    w = [m("p"), m("q")]
    r = align_new(stored, w)
    assert r.overlap == 0 and r.gap and [x.body for x in r.new] == ["p", "q"]


def test_direction_matters():
    stored = keys([m("네", d="inbound")])
    w = [m("네", d="inbound"), m("네", d="outbound")]
    r = align_new(stored, w)
    assert [(x.body, x.direction) for x in r.new] == [("네", "outbound")]


def test_external_ids_use_set_difference():
    w = [m("a", ext="1"), m("a", ext="2")]
    r = align_new(["ext:1"], w, stored_external_ids={"1"})
    assert [x.external_id for x in r.new] == ["2"]


def test_fingerprint_chain_distinguishes_repeats():
    a = fingerprint(1, m("네"), None, prev_fp="p1")
    b = fingerprint(1, m("네"), None, prev_fp=a)
    assert a != b
    assert fingerprint(1, m("네"), None, prev_fp="p1") == a
