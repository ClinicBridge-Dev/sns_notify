# 인수 체크리스트 (기준: 1109plan.md §8 12항목)

표기: ✅ 통과 · 🧪 자동 테스트로만 확인(가짜 리더) · ⏳ 실기기 확인 필요 · ❌ 실패

| # | 항목 | 단계 | 상태 | 근거 |
|---|---|---|---|---|
| 1 | 긴 메시지·줄바꿈·연속 메시지 본문을 빠짐없이 읽는가 | 0 | ⏳ | ax-notes B |
| 2 | 고객 수신과 모바일 상담사 발신을 구별하는가 | 0 | ⏳ | ax-notes C |
| 3 | 앱 앞/뒤, 음소거, 알림 꺼짐에서도 재확인으로 잡히는가 | 0 | ⏳ | 주기 재확인은 구현됨(`poll_interval_sec`, `full_sweep_interval_sec`); 실측 필요 |
| 4 | 안읽음 0이어도 새 상담사 발신을 수집하는가 | 1 | 🧪⏳ | 수집이 안읽음이 아닌 목록 커서+주기 순회 기반. `test_initial_baseline_then_live` |
| 5 | 같은 분 "네" 두 건을 각각 보존하는가 | 1 | 🧪⏳ | `test_two_identical_ne_kept_and_restart_no_dupes`, `test_two_identical_ne_same_minute_are_kept` |
| 6 | 인용된 옛 메시지를 신규로 중복 저장하지 않는가 | 1 | ⏳ | 리더가 `quote_suspect` 표시 → `confidence=review`(`test_review_confidence`). 인용 구조 실측 필요 |
| 7 | 같은 표시 이름·이름 변경을 구분하는가 | 1 | 🧪⏳ | external_key 있을 때만 이름 변경 추적(`test_rename_with_external_key`). 키가 없으면 이름이 식별자 — 실측 필요 |
| 8 | 원문 저장 직후 종료·재부팅 시 번역·Slack을 이어가는가 | 2 | 🧪 | DB 상태 기반 작업자, `test_end_to_end` 재시작 구간 |
| 9 | 번역 실패·Slack 429·타임아웃을 구분해 복구하는가 | 2·3 | 🧪 | `test_service_error_keeps_retrying_beyond_max`, `test_429_retries_without_duplicate`, `test_timeout_goes_unconfirmed_and_is_not_resent` |
| 10 | 최초 과거 수집은 알림 없음, 운영 중 놓친 고객 메시지는 지연 알림 | 1·3 | 🧪 | `test_end_to_end`(baseline 알림 0), `test_disconnected_then_recovery_is_catchup`, `test_gap_triggers_scrollback_and_catchup` |
| 11 | 다른 고객사 채널로 가지 않는가 | 3 | 🧪 | `test_routes_to_client_channel_and_records_ts`. 다계정 실측은 Phase 6 |
| 12 | 끊김·잠금·로그아웃을 성공으로 오인하지 않고 알리는가 | 1·5 | 🧪⏳ | `test_disconnected_then_recovery_is_catchup`, `test_ax_permission_loss_recorded_once`. WhatsApp 끊김 화면 판별은 ax-notes I |

## 단계별 종료 조건 메모

- Phase 4: 6명 동시 접속 지연 — 실측 필요. 쓰기 엔드포인트 없음 — `test_no_write_endpoints` 🧪.
- Phase 5: 수집기 kill → 앱이 2초 내 재시작 🧪(스크래치 복사본에서 확인), 앱 종료 신호 → 수집기 정상 종료 🧪.
  재부팅 → 자동 로그인 후 수집 재개, 화면 잠금 중 수집 여부 — 실기기 ⏳.
- 손쉬운 사용 권한이 「WhatsApp 수집기」 앱 기준으로 적용되는지 — 실기기에서 허용 후 메뉴 표시로 확인 ⏳.
