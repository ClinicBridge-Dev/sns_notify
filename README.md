# sns_notify — Meta 수신함 보조 확장 프로그램

**현재 메인 제품.** Meta Business Suite 수신함(business.facebook.com/latest/inbox)에서 동작하는 Chrome MV3 확장
프로그램. Instagram·WhatsApp 새 메시지 Slack 알림(R1), 말풍선 번역·복사(R2~R4), 한글 입력 번역 전송(R5),
빠른 메시지(R6, R7). 서버 없이 확장 프로그램이 Slack·DeepL을 직접 호출한다.

- 기획서: `docs/etc/meta-inbox-extension-implementation-spec.md` (v1.8, 현재는 `... spec copy 2.md` — 계획서 Task 1에서 이 이름으로 옮김)
- 구현 계획: `docs/etc/2026-11-12-meta-inbox-extension-impl-plan.md`
- 상태: **구현 완료, 자동 테스트 186개 통과, 실제 화면 수동 확인 전.** Meta 화면에서는 아직 실행해 보지 않았다. 사용 전 `docs/etc/meta-inbox-extension-manual-checks.md`의 체크리스트(U1–U12, R1–R7)를 테스트 계정으로 확인한다. 코드는 `extension/`.
- 설치: Chrome → 확장 프로그램 → 개발자 모드 → 「압축 해제된 확장 프로그램 로드」 → `extension/` 선택
- 테스트: `node --test extension/test/*.test.js`

> `extension/`(메인)과 `chrome-extension/`(레거시)은 다른 프로그램이다. 이름이 비슷하니 혼동하지 않는다.

---

# 레거시: local-whatsapp (Mac mini 수집기 + 서버 경유 알림)

> **레거시.** 새 기능은 넣지 않고, 이미 설치된 곳의 운영·버그 수정만 한다. 사무실 Mac에서 아직 이 경로로
> 실행 중일 수 있으므로 파일을 옮기거나 지우지 않는다. 해당 코드: `app/`, `web/`, `mac/`, `scripts/`, `launchd/`,
> `tests/`, `chrome-extension/`, `pyproject.toml`, `config.example.yaml`. 문서: `docs/PRODUCT_SPEC.md`,
> `docs/OPERATIONS.md`, `docs/etc/2026-11-09-impl-plan.md` 등.

Mac mini 한 대에서 상담용 WhatsApp 화면을 읽어 로컬 SQLite에 저장하고, 외국어는 한국어 번역을 붙이고,
고객의 새 메시지만 고객사 Slack 채널로 알리고, 직원이 읽기 전용 화면에서 대화를 보는 서비스.
계획: `docs/etc/2026-11-09-impl-plan.md` · 기획서: `docs/PRODUCT_SPEC.md`

> **MVP (2026-11-10): 새 메시지 알림.** 왓츠앱 대화 목록과 인스타그램 DM 목록(Primary·General)만 보고
> "새로운 N건 / 확인하지 않은 M건 + 미리보기"를 Slack으로 보낸다. 대화방을 열지 않아 안 읽음 뱃지가 남는다.
> 설치·운영은 **`docs/OPERATIONS.md`**. 왓츠앱 계정은 기본이 `mode: notify`(목록만 읽기)이고, 아래의 전체 대화
> 저장·번역·뷰어는 `mode: collect`일 때만 동작한다(대화방을 열므로 읽음 처리됨).
>
> **현재 상태:** Phase 1–5 코드와 테스트 완료(가짜 리더 기준). **Phase 0(실기기 화면 읽기) 미검증** —
> `app/collector/ax_reader.py`의 WhatsApp 화면 구조 해석은 실제 AX 덤프를 본 뒤 작성한다. 그 전까지 `ax`
> 계정은 상태 `unknown / ax_rules_pending_phase0`으로 표시되고 아무것도 저장하지 않는다.

## 구조

```
app/
  main.py                 단일 프로세스: collector(s) + translator + slack + ops + backup + api (asyncio TaskGroup)
  config.py               config.yaml + .env 로드, clients/accounts DB 동기화
  cli.py                  운영 CLI (Slack 미확인 대조, 이벤트, 상태)
  db/                     migrations/001_init.sql, repo.py (WAL, 트랜잭션)
  collector/
    contract.py           Reader 계약 + FakeReader  ← 수집 방식 교체 지점
    fingerprint.py        창(window) 정렬 + 연쇄 fingerprint (같은 분 "네" 두 건 구분)
    loop.py               baseline / live / catchup, 원문+번역작업 같은 트랜잭션, 커서
    ax.py, ax_reader.py   macOS 손쉬운 사용 래퍼, WhatsApp 리더(Phase 0 대기)
  translator/             detect(한국어는 API 호출 없음), gpt(본문=데이터), worker(재시도)
  slack/                  outbox 규칙, format(escaping), sender(429/미확인/chat.update)
  ops/                    status, heartbeat + 운영 알림, 일일 백업
  api/                    FastAPI REST + SSE + 공용 비밀번호 세션, 정적 뷰어 서빙
  static/                 web/ 빌드 결과 (커밋 대상, Node 없이 서빙)
web/                      Vite + React + TS 뷰어 소스
mac/WhatsAppCollector/    「WhatsApp 수집기」 메뉴 막대 앱 (Swift) — 손쉬운 사용 권한을 받는 주체
scripts/                  build_app.sh, install_app.sh, ax_dump.py, backup.sh
launchd/                  LaunchAgent plist 템플릿 (앱을 로그인 시 실행)
```

## 설치 (Mac mini)

```sh
uv sync                                   # Python 3.13 (.python-version)
cp config.example.yaml config.yaml        # 고객사·계정·채널
cp .env.example .env && chmod 600 .env    # OPENAI_API_KEY, SLACK_TOKEN_*, VIEWER_PASSWORD, SESSION_SECRET
scripts/install_app.sh                    # 앱 설치 + 로그인 시 자동 실행
```

설치하면 메뉴 막대에 말풍선 아이콘(「WhatsApp 수집기」)이 생깁니다. 이 앱이 수집 프로그램을 띄우고, 죽으면 다시 띄우고,
Mac이 잠들지 않게 합니다. **손쉬운 사용 권한은 이 앱 하나에만** 줍니다:
시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용 → 「WhatsApp 수집기」 켜기. (터미널이나 python에는 줄 필요 없음)

- **앱이 직접** macOS 접근성 API로 WhatsApp이 알려 주는 글자·버튼 정보를 읽습니다(`mac/WhatsAppCollector/Bridge.swift`).
  화면 캡처나 VoiceOver는 쓰지 않습니다. Python 수집기는 앱에 "이 부분 구조를 알려 줘 / 이 버튼을 눌러 줘"라고
  요청만 합니다. macOS는 앱이 받은 권한을 앱이 띄운 다른 프로그램에 나눠 주지 않기 때문입니다(실기기 확인).
  요청 통로는 앱이 수집기를 띄울 때 만든 전용 연결이라, 다른 프로그램은 이 권한을 쓸 수 없습니다.
- 앱은 WhatsApp 화면을 해석하지 않는 범용 통로라서, 해석 규칙(Python)을 고쳐도 앱을 다시 빌드하지 않고 권한도 유지됩니다.
  `mac/WhatsAppCollector`를 고쳐 앱이 다시 빌드되면 권한을 다시 켜야 합니다(설치 스크립트가 알려 줌).
- 저장소는 `~/Documents`·`~/Desktop`·`~/Downloads` 밖에 두세요. 안에 두면 그 폴더 접근 허용을 한 번 더 묻습니다.
- 메뉴: 대화 화면 열기 · 손쉬운 사용 설정 열기 · 화면 구조 기록(진단) · 로그 폴더 열기 · 수집기 다시 시작 · 종료.
- 삭제: `scripts/install_app.sh uninstall` — 앱·자동 실행·실행기 설정·손쉬운 사용 항목을 지움. 저장소 안의
  대화 DB(`data/`)·로그·설정과 백업은 남김. 이것까지 지우려면 따로 삭제.
- 개발 중 직접 실행: `uv run python -m app.main` (이때 권한은 터미널 기준이라 WhatsApp 읽기는 안 됨)

뷰어를 고친 경우만: `cd web && npm install && npm run build` (결과가 `app/static`에 들어감).


## 가짜 리더로 미리 보기

```yaml
# config.yaml 의 account 하나를
- {key: demo-1, label: 데모, collect_method: fake, session_key: tests/fixtures/demo.json}
```

## 테스트

```sh
uv run pytest -q            # 단위 + 통합 (collector→DB→translator(mock)→outbox→sender(fake), SSE bus)
cd web && npm run build     # 타입체크 + 빌드
```

## Phase 0 (실기기) 진행 방법

`docs/etc/ax-notes.md` 참고. 요약: 앱 설치 → 「WhatsApp 수집기」에 손쉬운 사용 허용 → WhatsApp에서 테스트 대화방을 연 상태로
메뉴 「화면 구조 기록 (진단)」 → 결과(`ax_dumps/`)로 `ax_reader.py`의 `WhatsAppRules`를 작성 → `docs/etc/acceptance.md` 체크.

## 운영

- Slack 미확인(타임아웃 등)은 자동 재전송하지 않는다: `uv run python -m app.cli outbox list` →
  Slack에서 확인 후 `outbox mark-sent ID` 또는 `outbox resend ID`.
- 운영 이벤트: `uv run python -m app.cli events`, 상태: `uv run python -m app.cli status`.
- 백업: `ops.backup_dir` 설정 시 매일 `backup_hour_local` 이후 1회(14일 보관). 수동: `scripts/backup.sh`.
- 로그: `logs/app.log` (10MB × 5 회전). 메시지 본문과 비밀값은 로그에 쓰지 않는다.

## 새 메시지 알림 (왓츠앱 목록 + 인스타그램 DM 목록)

운영 방법 전체는 `docs/OPERATIONS.md`.

- `app/notices/core.py` — 목록 스냅샷 → 알림 판정(첫 스냅샷은 조용한 기준선) → 계정별 묶음 Slack 메시지(건수 포함).
- `app/notices/whatsapp.py` — 왓츠앱 대화 목록 행만 읽는 감시기. `perform`/`set`을 호출하지 않는다(테스트로 강제).
- `app/notices/instagram.py` + `chrome-extension/` — instagram.com DM 목록의 안 읽은 줄(이름·미리보기)을 읽어
  `/api/ingest/instagram`으로 보낸다. 클릭·스크롤·인스타그램으로의 요청 없음(테스트로 강제).
- 상태: `uv run python -m app.cli watch` · 재전송: `uv run python -m app.cli notices resend ID`

테스트: `uv run pytest -q` · `node --test chrome-extension/test/parse.test.js`
