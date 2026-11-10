# AX 트리 메모 (Phase 0)

상태: **미작성 — 실기기 덤프 전.** 이 문서는 Phase 0 진행 절차와, 덤프를 보고 채워야 할 항목의 틀이다.
WhatsApp Mac 앱: `net.whatsapp.WhatsApp` 26.43.77 (Catalyst 계열로 보임: `WAAppKitBridge.framework`). 구조는 추정하지 않는다.

## 1. 준비

1. 테스트용 고객 번호와 대화방 1개를 준비한다(실제 고객 대화로 실험하지 않는다).
2. `scripts/install_app.sh`로 「WhatsApp 수집기」 앱을 설치한다.
3. 시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용 → 「WhatsApp 수집기」를 켠다. 메뉴 막대 아이콘의
   "손쉬운 사용 권한: 허용됨"으로 확인한다. (터미널·python에는 권한을 주지 않는다)
4. WhatsApp에서 테스트 대화방을 열고 메뉴 「화면 구조 기록 (진단)」을 누른다 → `ax_dumps/tree-*.json`.
   아래 표의 `find`/`observe`처럼 더 필요한 실험은 개발자가 앱과 같은 권한으로 돌린다
   (앱 메뉴 항목을 추가하거나, 개발 Mac에서만 터미널에 임시로 권한을 준다).

덤프 파일(`ax_dumps/`)에는 실제 메시지가 들어간다. 소유자 전용 권한으로 저장되고 git에서 제외된다. 끝나면 지운다.

## 2. 수집할 것

| # | 실험 | 명령 | 기록할 것 |
|---|---|---|---|
| A | 대화 목록 위치 | 목록이 보이는 상태에서 `dump`, `find "<대화방 이름>"` | 목록 컨테이너 path/role, 행 하나의 텍스트 구성(이름·미리보기·시각·안읽음 수), 행에 안정 식별값(AXIdentifier 등)이 있는지 |
| B | 말풍선 | 테스트 대화방을 열고 `find "<보낸 문장>"` | 말풍선 path/role, 본문이 AXValue/AXDescription 어디에 있는지, 긴 글·줄바꿈이 잘리지 않는지 |
| C | 수신/발신 | 고객→상담, 상담(휴대폰)→고객 각각 보낸 뒤 B 반복 | 방향을 알려주는 속성(설명 문구, frame.x 좌우 위치, subrole 등). 문체로 추측 금지 |
| D | 같은 분 "네" 두 번 | 고객이 "네"를 연속 2회 | 두 노드가 각각 보이는지, 순서가 유지되는지, 구분 가능한 속성 |
| E | 날짜 구분선 | 어제/오늘 메시지가 섞인 방 | 구분선 노드와 텍스트("오늘", "어제", 날짜) |
| F | 인용 답장 | 고객이 옛 메시지를 인용해 답장 | 인용 부분이 별도 노드인지, 말풍선 텍스트에 섞이는지 (`quote_suspect` 플래그 조건) |
| G | 첨부/음성/스티커 | 사진(캡션 有/無), 음성, 스티커 | kind 판별 근거, 캡션 위치 |
| H | 이벤트 | `observe --seconds 180` 동안 새 메시지 수신(앱 앞/뒤, 음소거 방) | 등록 결과(0=지원), 새 메시지 때 어떤 알림이 오는지, 지연 |
| I | 연결 상태 | 휴대폰 비행기 모드, 앱 로그아웃 화면 | 끊김 배너/로그인 화면을 식별할 텍스트 → `connection_state` |
| J | 잠금 | 화면 잠금 상태에서 `check`, `dump` | 잠금 중 AX 읽기 가능 여부 |
| K | 재확인 주기 | 대화방 30개 기준 1회 순회 시간 | `poll_interval_sec`, `full_sweep_interval_sec` 결정 |

## 3. 덤프 후 작성할 코드

`app/collector/ax_reader.py`에 `PendingRules` 대신 `WhatsAppRules`(같은 메서드 3개)를 만든다.
규칙은 AX 요소를 직접 만지지 않고 `backend`(앱 경유 통로)만 쓴다: `backend.snapshot(path, depth)`로 구조(dict)를
받아 해석하고, 동작은 `backend.perform(path, "AXPress", expect_role=...)` / `backend.set(...)`으로 요청한다.
테스트는 덤프를 `FakeBackend`에 넣어 돌린다(`app/collector/ax_backend.py`).

- `connection_state(backend)` → `ReaderStatus('ok'|'disconnected'|'locked'|'unknown', detail)`
- `list_conversations(backend)` → `ObservedConversation(display_name, external_key?, is_group, list_cursor)`
  - `list_cursor`: 행의 미리보기+시각+안읽음 수를 이어 붙인 값. 바뀐 방만 연다.
- `read_messages(backend, conv, limit)` → `MessageWindow(messages 오래된→최신, at_start)`
  - 방을 열 때 필요한 AX 동작(AXPress/선택)은 여기만. 스크롤로 `limit`까지 올라간다.
  - 방향을 확신 못 하면 `direction='unknown'`, 인용이 섞였으면 `flags=('quote_suspect',)`.
  - `shown_date_hint`는 가능하면 `YYYY-MM-DD`로 정규화("오늘"/"어제" → 실제 날짜).

규칙은 이 파일 한 곳에만 둔다(앱 업데이트로 구조가 바뀌면 여기만 고친다). 덤프 일부를 개인정보를 지운 뒤
`tests/fixtures/ax/`에 넣고 `WhatsAppRules` 파서를 그 파일로 테스트한다.

## 4. go / no-go

`docs/etc/acceptance.md`의 Phase 0 항목이 모두 통과하면 go. 하나라도 구조적으로 불가하면 WhatsApp Web +
영속 브라우저 프로필로 전환(`collect_method: web` 리더를 같은 계약으로 작성).

## 5. 측정 결과

### 2026-11-09 1차 (WhatsApp 26.43.77, 한국어 UI, 테스트 계정)

- 권한: 「WhatsApp 수집기」 앱에만 허용. 앱이 띄운 Python에는 권한이 넘어가지 않음(-25211) → 앱이 직접 읽고 Python은 요청만 하는 구조로 변경.
- 덤프: 창 전체 354개 요소, 0.6초. 구조는 `app/collector/wa_rules.py` 머리말에 정리.
- 읽기 결과(열려 있던 대화방, 클릭 없음): 화면의 말풍선 8개 전부 읽음.
  - 방향: "내 메시지"/"메시지" 접두어 + "보냈습니다"/"받았습니다" 접미어 두 곳이 일치 → 발신 4, 수신 3, 시스템 안내 1.
  - 본문: 줄바꿈 포함 긴 글(315자) 잘림 없이 읽음. 본문 안의 쉼표도 유지.
  - 시각: 말풍선마다 월·일·오전/오후·분이 있음. 연도는 비어 있어(“년 10월 27일”) 오늘 기준으로 채움.
  - 날짜 구분선(AXHeading)은 글자가 없음 → 말풍선 자체 날짜를 사용.
- 대화 목록: 행마다 이름 + 마지막 메시지 요약(시각 포함). 전화번호는 목록에서 "+ 1,5 5 5,…", 상단에서 "+1 (555) …"로 달라 정규화(+15551410740).

### 아직 확인 못 한 것

- 화면에 보이는 말풍선만 존재(가상화된 표) → 위로 스크롤해 과거 읽기 미구현.
- 사진·음성·스티커·인용 답장·그룹 대화의 표시 형식(샘플 없음).
- 다른 대화방을 여는 동작(AXPress)은 실기기 미시험. 연결된 기기에서 대화방을 열면 상대에게 읽음 표시가 갈 수 있음.
- 휴대폰 연결 끊김·로그아웃 화면 판별.
