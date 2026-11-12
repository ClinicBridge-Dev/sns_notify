# Meta 수신함 보조 확장 프로그램 구현 계획서

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Meta Business Suite 수신함에서 동작하는 Chrome MV3 확장 프로그램을 만든다. Instagram·WhatsApp 새 메시지를 Slack으로 알리고(R1), 말풍선 번역·복사(R2~R4), 한글 입력 번역 전송(R5), 빠른 메시지(R6, R7)를 제공한다.

**Architecture:** content script는 화면에서 본 것(배지 값, 목록 후보, 사용자 입력)을 그대로 service worker에 보내고, 판단·저장·외부 호출(Slack, DeepL)은 service worker가 한다. 판단 로직은 DOM과 chrome API에 의존하지 않는 순수 함수로 `extension/lib/`에 두어 `node --test`로 검증하고, DOM을 다루는 부분은 테스트 대화에서 수동 확인한다.

**Tech Stack:** 순수 JavaScript(빌드 도구·외부 라이브러리 없음), Chrome Manifest V3, Node 22 내장 테스트 러너(`node:test`, `node:assert`).

**Spec:** `docs/etc/meta-inbox-extension-implementation-spec.md` (v1.8). Task 1에서 현재의 `... spec copy 2.md`를 이 이름으로 옮긴다. 이 계획서의 "n장", "n-m"은 모두 이 기획서의 절 번호다. 구현자는 자기 Task가 가리키는 절을 반드시 읽는다.

**저장소 위치 (2026-11-12 결정):** 이 확장 프로그램(`extension/`)이 저장소의 메인 제품이다. 기존 코드(`app/`, `web/`, `mac/`, `scripts/`, `launchd/`, `tests/`, `chrome-extension/` 등)는 레거시로 제자리에 둔다. 실행 중인 설치가 이 경로를 쓰므로 옮기거나 지우지 않고, 이 계획의 어떤 Task도 레거시 파일을 수정하지 않는다. README는 이미 이 확장 프로그램을 메인으로 소개하도록 바뀌어 있다.

## Global Constraints

- 외부 라이브러리와 빌드 도구를 쓰지 않는다. `extension/` 폴더를 "압축 해제된 확장 프로그램"으로 바로 로드할 수 있어야 한다.
- 기획서 4장 금지 사항 10개는 기능 요구보다 우선한다. 구현이 어렵다는 이유로 어기지 않는다.
- manifest 권한은 `storage`, `alarms`, `clipboardWrite`뿐이다. `tabs`, `scripting`, `webRequest`, `cookies`, `notifications`를 추가하지 않는다. `chrome.tabs`는 `onRemoved`와 `sendMessage`만 쓴다.
- host_permissions는 `https://business.facebook.com/*`, `https://hooks.slack.com/*`, `https://api.deepl.com/*`, `https://api-free.deepl.com/*` 네 개다.
- 외부 네트워크 요청은 service worker만 한다. content script는 `fetch`와 `chrome.storage`를 쓰지 않는다.
- content script는 main world에 스크립트를 주입하지 않는다. `fetch`, `XMLHttpRequest`, `WebSocket`, history API를 감싸지 않는다.
- 비밀값은 `slackWebhookUrl`, `deeplApiKey` 두 개다. content script로 가는 어떤 메시지에도 넣지 않는다.
- service worker의 상태는 모두 `chrome.storage.local`에 둔다. 메모리 변수는 캐시로만 쓴다.
- 모든 DOM 선택자는 `extension/content/selectors.js` 한 파일에만 둔다. 요소를 못 찾으면 사용자에게 상태를 표시한다.
- 주입하는 요소의 class와 id는 `mbx-` 접두사를 쓰고 Shadow DOM 안에 둔다. Meta가 만든 DOM은 입력창 내용(R5, R6) 외에는 바꾸지 않는다.
- 로그는 `console.debug`만 쓰고 메시지 본문을 넣지 않는다.
- 전송이 일어나는 수동 테스트는 테스트용 상대 계정과의 대화에서만 한다. 실제 고객 대화를 열지 않는다.
- 기획서에 없는 계획서 결정 3가지(기획서 검토에서 나온 보완):
  - 감소 대기와 건수 알림 기록은 저장소에 둔다: `watcherState.channels[채널].pending`, 최상위 키 `recentCountAlerts`.
  - service worker는 메시지를 도착 순서대로 하나씩 처리한다(직렬 큐). 저장소 읽기·쓰기 사이에 다른 메시지 처리가 끼어들지 않는다.
  - 번역 처리 중에 다시 누른 Enter·전송 버튼은 Meta에 넘기지 않고 삼킨다(기획서 8-2의 4번을 "가로채지 않는다"로만 읽으면 한글 원문이 나간다).
- 순수 로직 파일은 기존 `chrome-extension/parse.js`와 같은 방식으로 브라우저와 node 양쪽에서 로드한다:

```js
(function (root) {
  function example() {}
  root.example = example;
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
```

- 테스트 실행: `node --test extension/test/`. 커밋은 `extension/`과 이 계획이 명시한 문서만 `git add`한다(작업 트리에 관련 없는 변경이 많다). 작업은 새 브랜치 `feat/meta-inbox-extension`에서 한다.

### 상수 (기획서 값 그대로)

| 이름 | 값 | 출처 |
|-|-|-|
| `DROP_WAIT_MS` | 3000 | 6-1 감소 대기 |
| `HOLD_MS` | 5000 | 6-1 보류 |
| `SUPPLEMENT_WINDOW_MS` | 120000 | 6-1 보충 메시지 |
| `DEDUP_MS` | 600000 | 6-4 |
| `QUEUE_TTL_MS`, `SENT_KEY_TTL_MS` | 86400000 | 5장 |
| `RETRY_DELAYS_MS` | [30000, 120000, 600000], 이후 600000 반복 | 6-3 |
| `HEARTBEAT_MS` | 30000 | 6-5 |
| `OWNER_TIMEOUT_MS` | 90000 | 6-1 감지 담당 탭 |
| `STOP_AFTER_MS`, `SLEEP_GAP_MS` | 180000 | 6-5 |
| `SETTLE_LOAD_MS` / `SETTLE_CHANGE_MS` | 20000 / 3000 | 6-1 안정화 |
| `LIST_TOP_N` / `KNOWN_CAP` / `CANDIDATE_MAX` | 15 / 500 / 3 | 6-1 신호 2 |
| `LIST_DEBOUNCE_MS` | 1500 (탭이 보일 때만) | 6-1 |
| `SEND_PENDING_MS` / `BYPASS_MS` / `SEND_CONFIRM_MS` | 500 / 1000 / 1500 | 8-3, 8-5 |
| `DEEPL_TIMEOUT_MS` / `TRANSLATE_MAX_CHARS` | 10000 / 5000 | 8-6, 11장 |
| `THREAD_LANG_CAP` / `THREAD_LANG_RETRY_MS` | 500 / 500 | 5장, 8-2 |
| 빠른 메시지 한도 | 항목 500개, 제목 50자, 본문 2000자 | 10장 |

## Review Focus

Task의 자동 테스트가 직접 다루지 않지만 실제 사용에서 먼저 문제가 될 조건이다. 각 줄 끝의 Task에 이를 고정하는 테스트를 넣었다.

1. 확장 프로그램을 다시 로드한 뒤 기존 수신함 탭에서 한글을 전송 → 번역 요청이 실패한다. 한글 원문이 나가면 안 되고 "페이지를 새로고침하세요" 안내가 나와야 한다. (Task 13 수동 항목, `decideSend`의 `connected: false` 테스트)
2. Webhook 주소에 `hooks.slack.com`이 아닌 값을 넣음 → host 권한이 없어 조용히 실패한다. 저장 시 거부하고 이유를 보여야 한다. (Task 2 `validateWebhookUrl` 테스트)
3. 배지 보고가 연달아 도착 → 저장소 읽기·쓰기가 겹쳐 기준값이 틀어진다. 직렬 처리로 결과가 순차 적용과 같아야 한다. (Task 8 `serialQueue` 테스트)
4. 번역문에 줄바꿈·이모지·연속 공백이 있음 → 입력창 교체 후 비교가 실패해 전송이 막힌다. 정규화 비교가 같다고 판정해야 한다. (Task 13 `normalizeForCompare` 테스트)
5. 미리보기·발신자 이름에 `<!channel>`, `<https://x|y>`, `&`가 있음 → Slack에서 멘션·링크로 동작하면 안 된다. (Task 10 `buildSlackPayload` 테스트)

---

## File Structure

```
extension/
  manifest.json
  background.js            메시지 라우팅, 알람, 저장소, fetch (chrome API 접착부)
  lib/                     순수 로직 (node 테스트 대상)
    constants.js           위 상수 표
    settings.js            기본 설정, 비밀값 제거, 발신자 검증, Webhook 주소 검증
    quickreplies.js        가져오기 검증, 합치기
    deepl.js               주소 선택, 요청 구성, 오류 매핑
    threadlang.js          대화별 언어 저장 한도 관리
    badge.js               배지 기준값 비교 (감소 대기 포함)
    listcand.js            목록 항목 파싱, 키, 후보 판정
    combine.js             배지 이벤트와 목록 후보의 결합, 보류, 보충
    slack.js               메시지 형식, 가리기, 이스케이프, 중복 키, 재시도 간격
    owner.js               감지 담당 탭 선정
    watchdog.js            감지 중단 판정
    sendgate.js            전송 가로채기 판정, 한글·Enter 판별, 비교 정규화
    serial.js              직렬 큐
  content/
    selectors.js           모든 선택자, asset_id 읽기
    util.js                Shadow DOM 호스트, 토스트, 연결(port) 관리
    watcher.js             R1 관찰과 보고
    bubbles.js             R2~R4
    composer.js            R5, R6
    content.css
  options/
    options.html, options.js, options.css
  icons/
  test/
    *.test.js              lib 파일마다 하나
```

기획서 2-1의 구성에 `lib/`와 `test/`를 더했다. `lib/`는 service worker(`importScripts`)와 content script(manifest의 `js` 목록) 양쪽에서 로드한다. content script 목록에는 `constants.js`, `listcand.js`, `sendgate.js`만 넣는다.

### 저장소 구조 (기획서 5장 + 보완)

```json
{
  "settings": { "...기획서 5장 그대로": "" },
  "quickReplies": { "version": 1, "items": [] },
  "watcherState": {
    "channels": {
      "instagram_direct": { "base": 0, "known": false, "pending": null },
      "wec": { "base": 0, "known": false, "pending": null }
    },
    "ownerTabId": null, "lastHeartbeat": 0, "everSeen": false,
    "stoppedAlertSent": false, "lastAlarmAt": 0
  },
  "threadLangs": {},
  "slackQueue": [],
  "sentKeys": [],
  "recentCountAlerts": [],
  "lastError": null
}
```

기획서의 `badges`와 `badgesKnown`은 채널별 `base`, `known`으로 옮겼다(감소 대기 `pending: {value, at}`를 채널별로 함께 두기 위해서다).

---

### Task 1: 기획서 정리와 뼈대

**Files:**
- Move: `docs/etc/meta-inbox-extension-implementation-spec copy 2.md` → `docs/etc/meta-inbox-extension-implementation-spec.md` (덮어쓰기), Delete: `docs/etc/meta-inbox-extension-implementation-spec copy.md`
- Create: `extension/manifest.json`, `extension/background.js`, `extension/lib/constants.js`, `extension/lib/settings.js`, `extension/lib/serial.js`, `extension/options/options.html`, `extension/options/options.js`, `extension/options/options.css`, `extension/icons/` (16, 48, 128 PNG)
- Test: `extension/test/settings.test.js`, `extension/test/serial.test.js`

**Interfaces:**
- Produces (`lib/settings.js`):
  - `DEFAULT_SETTINGS` — 기획서 5장의 `settings` 객체 그대로
  - `publicSettings(settings) -> object` — `slackWebhookUrl`, `deeplApiKey`를 뺀 사본
  - `classifySender(sender, extensionId) -> 'content' | 'options' | 'reject'`
  - `isAllowed(type, senderKind) -> boolean`
- Produces (`lib/serial.js`): `createSerialQueue() -> (fn: () => Promise<T>) => Promise<T>` — 넘긴 함수를 호출 순서대로 하나씩 실행
- Produces (`background.js`): `handlers` 객체에 `handlers[type] = async (msg, sender) => response` 형태로 등록하는 라우터. 이후 Task는 여기에 핸들러만 추가한다. 모든 핸들러는 직렬 큐 안에서 실행된다. 저장소 접근은 `loadState(keys)`, `saveState(patch)` 두 함수로만 한다.

- [ ] **Step 1: 브랜치를 만들고 기획서 파일을 정리한다**

```bash
git switch -c feat/meta-inbox-extension
mv "docs/etc/meta-inbox-extension-implementation-spec copy 2.md" docs/etc/meta-inbox-extension-implementation-spec.md
rm "docs/etc/meta-inbox-extension-implementation-spec copy.md"
head -3 docs/etc/meta-inbox-extension-implementation-spec.md
```

Expected: 셋째 줄이 `버전: 1.8`로 시작한다.

- [ ] **Step 2: 실패하는 테스트를 쓴다** (`extension/test/settings.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/settings.js');
const EXT = 'abcdefghijklmnopabcdefghijklmnop';

test('publicSettings removes both secrets and keeps the rest', () => {
  const p = S.publicSettings({ ...S.DEFAULT_SETTINGS, slackWebhookUrl: 'https://hooks.slack.com/services/x', deeplApiKey: 'k:fx' });
  assert.equal('slackWebhookUrl' in p, false);
  assert.equal('deeplApiKey' in p, false);
  assert.equal(p.sendTargetLang, 'EN-US');
});

test('classifySender', () => {
  assert.equal(S.classifySender({ id: EXT, tab: { id: 1, url: 'https://business.facebook.com/latest/inbox/wec?asset_id=1' } }, EXT), 'content');
  assert.equal(S.classifySender({ id: EXT, url: `chrome-extension://${EXT}/options/options.html` }, EXT), 'options');
  assert.equal(S.classifySender({ id: EXT, tab: { id: 1, url: 'https://www.facebook.com/' } }, EXT), 'reject');
  assert.equal(S.classifySender({ id: 'other', url: `chrome-extension://${EXT}/options/options.html` }, EXT), 'reject');
});

test('isAllowed separates content and options messages', () => {
  assert.equal(S.isAllowed('TRANSLATE', 'content'), true);
  assert.equal(S.isAllowed('SEND_TEST_SLACK', 'content'), false);
  assert.equal(S.isAllowed('SEND_TEST_SLACK', 'options'), true);
  assert.equal(S.isAllowed('GET_QUICK_REPLIES', 'content'), true);
  assert.equal(S.isAllowed('GET_QUICK_REPLIES', 'options'), true);
  assert.equal(S.isAllowed('BADGE_STATE', 'options'), false);
});
```

`extension/test/serial.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { createSerialQueue } = require('../lib/serial.js');

test('runs jobs one at a time in call order', async () => {
  const run = createSerialQueue();
  const log = [];
  const job = (name, ms) => run(async () => { log.push(name + ':start'); await new Promise(r => setTimeout(r, ms)); log.push(name + ':end'); return name; });
  const results = await Promise.all([job('a', 20), job('b', 1)]);
  assert.deepEqual(log, ['a:start', 'a:end', 'b:start', 'b:end']);
  assert.deepEqual(results, ['a', 'b']);
});

test('a rejected job does not block the next one', async () => {
  const run = createSerialQueue();
  await assert.rejects(run(async () => { throw new Error('x'); }));
  assert.equal(await run(async () => 1), 1);
});
```

- [ ] **Step 3: 테스트가 실패하는지 확인한다**

Run: `node --test extension/test/`
Expected: FAIL — `Cannot find module '../lib/settings.js'`

- [ ] **Step 4: `lib/constants.js`, `lib/settings.js`, `lib/serial.js`를 구현한다**

`isAllowed`의 구분: content 전용은 기획서 11장 표의 type 전부(`GET_PUBLIC_SETTINGS`, `BADGE_STATE`, `LIST_CANDIDATE`, `SET_THREAD_LANG`, `GET_THREAD_LANG`, `HEARTBEAT`, `HELLO`, `TRANSLATE`, `OPEN_OPTIONS`), options 전용은 `SEND_TEST_SLACK`, `CHECK_DEEPL_KEY`, `GET_STATUS`, `SET_ASSET_FROM_OPEN_TAB`, 양쪽 허용은 `GET_QUICK_REPLIES`.

- [ ] **Step 5: `manifest.json`, `background.js`, options 뼈대를 만든다**

- manifest는 기획서 2-2 그대로. `content_scripts`는 이 Task에서는 넣지 않는다(Task 4에서 추가).
- `background.js`: `importScripts`로 `lib/constants.js`, `lib/settings.js`, `lib/serial.js`를 로드한다. 시작 시 `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`를 호출하고, 저장소에 없는 최상위 키를 위 "저장소 구조"의 기본값으로 채운다. `chrome.runtime.onMessage`에서 `classifySender` → `isAllowed` → 직렬 큐 → `handlers[type]` 순으로 처리하고, 거부된 메시지에는 `{ ok: false, code: 'REJECTED' }`를 돌려준다.
- 핸들러 2개를 등록한다: `GET_PUBLIC_SETTINGS`(→ `publicSettings`), `OPEN_OPTIONS`(→ `chrome.runtime.openOptionsPage()`).
- options 페이지: 기획서 10-4의 항목을 섹션 제목만 있는 빈 틀로 만들고, 설정 읽기·쓰기는 `chrome.storage.local`을 직접 쓴다(options는 신뢰 영역이다).

- [ ] **Step 6: 테스트와 로드를 확인한다**

Run: `node --test extension/test/`
Expected: PASS (5 tests)

수동: `chrome://extensions`에서 `extension/`을 로드한다. 오류 없이 로드되고, options 페이지가 열리고, service worker 콘솔에서 `chrome.storage.local.get(null)`이 위 저장소 구조를 돌려준다.

- [ ] **Step 7: 커밋**

```bash
git add extension docs/etc/meta-inbox-extension-implementation-spec.md docs/etc/2026-11-12-meta-inbox-extension-impl-plan.md
git commit -m "Add Meta inbox extension skeleton and consolidate spec v1.8"
```

---

### Task 2: 빠른 메시지 관리와 설정 화면 (R7)

기획서 10장.

**Files:**
- Create: `extension/lib/quickreplies.js`, `extension/test/quickreplies.test.js`
- Modify: `extension/lib/settings.js`, `extension/test/settings.test.js`, `extension/options/options.html`, `extension/options/options.js`, `extension/options/options.css`, `extension/background.js`

**Interfaces:**
- Produces (`lib/quickreplies.js`):
  - `validateImport(parsed) -> { ok: true, items } | { ok: false, errors: [{ index, reason }] }` — `{version: 1, items: [...]}` 또는 배열을 받는다
  - `mergeImport(existing, incoming, mode, newId) -> { items, added, changed }` — `mode`는 `'merge'` 또는 `'replace'`, `newId`는 id를 만드는 함수
  - `exportFileName(date) -> 'quick-replies-YYYYMMDD.json'`
- Produces (`lib/settings.js`): `validateWebhookUrl(url) -> { ok: true } | { ok: false, reason }` — 빈 문자열은 허용, 그 외에는 `https://hooks.slack.com/`으로 시작해야 한다
- Produces (`background.js`): 핸들러 `GET_QUICK_REPLIES` → `{ version, items }`

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`extension/test/quickreplies.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert');
const Q = require('../lib/quickreplies.js');
const item = (o) => ({ id: 'a', title: '예약 양식', text: '예약을 위해 아래 정보를 보내 주세요.', tags: ['예약'], ...o });

test('accepts both the wrapped object and a bare array', () => {
  assert.equal(Q.validateImport({ version: 1, items: [item()] }).ok, true);
  assert.equal(Q.validateImport([item()]).ok, true);
});

test('reports which item is wrong and why', () => {
  const r = Q.validateImport([item(), item({ title: 123 }), item({ text: 'x'.repeat(2001) }), item({ title: 'x'.repeat(51) })]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map(e => e.index), [1, 2, 3]);
});

test('rejects more than 500 items and non-list input', () => {
  assert.equal(Q.validateImport(Array.from({ length: 501 }, () => item())).ok, false);
  assert.equal(Q.validateImport({ foo: 1 }).ok, false);
});

test('merge overwrites same id, adds new, issues id when missing', () => {
  const existing = [item({ id: 'a', title: '옛 제목' }), item({ id: 'b' })];
  const incoming = [item({ id: 'a', title: '새 제목' }), item({ id: undefined, title: '추가' })];
  const r = Q.mergeImport(existing, incoming, 'merge', () => 'new-1');
  assert.deepEqual(r.items.map(i => [i.id, i.title]), [['a', '새 제목'], ['b', '예약 양식'], ['new-1', '추가']]);
  assert.equal(r.added, 1);
  assert.equal(r.changed, 1);
});

test('replace discards existing items', () => {
  const r = Q.mergeImport([item({ id: 'a' })], [item({ id: 'z' })], 'replace', () => 'n');
  assert.deepEqual(r.items.map(i => i.id), ['z']);
});

test('export file name', () => {
  assert.equal(Q.exportFileName(new Date(2026, 10, 12)), 'quick-replies-20261112.json');
});
```

`extension/test/settings.test.js`에 추가:

```js
test('validateWebhookUrl accepts only Slack webhook hosts', () => {
  assert.equal(S.validateWebhookUrl('').ok, true);
  assert.equal(S.validateWebhookUrl('https://hooks.slack.com/services/T/B/x').ok, true);
  assert.equal(S.validateWebhookUrl('https://example.com/hook').ok, false);
  assert.equal(S.validateWebhookUrl('http://hooks.slack.com/services/T/B/x').ok, false);
});
```

- [ ] **Step 2: 실패 확인** — Run: `node --test extension/test/` / Expected: FAIL — `Cannot find module '../lib/quickreplies.js'`

- [ ] **Step 3: `lib/quickreplies.js`와 `validateWebhookUrl`을 구현한다**

- [ ] **Step 4: 통과 확인** — Run: `node --test extension/test/` / Expected: PASS

- [ ] **Step 5: options 화면을 구현한다**

- 빠른 메시지: 목록, 추가, 수정, 삭제, 위·아래 순서 변경. 저장은 즉시 `quickReplies`에 반영.
- 내보내기: `Blob` + `a[download]`, 내용은 `JSON.stringify(quickReplies, null, 2)`.
- 가져오기: `input[type=file]` → `JSON.parse` → `validateImport` → 실패 시 항목별 이유 표시(기존 데이터 유지) → 성공 시 "합치기 / 전체 교체" 선택 → "N개 추가, M개 변경" 확인 후 적용.
- 그 밖의 설정(10-4): Slack 사용 여부·미리보기 길이·전화번호 가리기, Webhook 주소(저장 시 `validateWebhookUrl`, 입력 후 가려서 표시), DeepL 키(가려서 표시, `:fx`로 끝나면 14장의 무료 키 경고 표시), 번역 켬/끔과 기본 대상 언어(5장의 언어 목록), 6-6의 운영 안내와 6-5의 한계 문구.
- [테스트 메시지 보내기], [키 확인], [현재 수신함을 알림 대상으로 지정], 상태 영역은 버튼과 자리만 만들고 Task 3, 10, 12에서 연결한다.

- [ ] **Step 6: 수동 확인**

- 빠른 메시지를 3개 추가하고 브라우저를 재시작해도 남아 있다.
- 내보낸 파일을 그대로 "전체 교체"로 가져오면 목록이 동일하다.
- 깨진 JSON, `title` 없는 항목이 든 파일을 가져오면 이유가 표시되고 기존 목록이 그대로다.
- Webhook 주소에 `https://example.com/x`를 넣으면 저장이 거부된다.

- [ ] **Step 7: 커밋** — `git add extension && git commit -m "Add quick reply management and settings page"`

---

### Task 3: DeepL 번역 호출 (service worker)

기획서 7-3, 7-4, 8-1의 3번, 11장.

**Files:**
- Create: `extension/lib/deepl.js`, `extension/test/deepl.test.js`
- Modify: `extension/background.js`, `extension/options/options.js`

**Interfaces:**
- Produces (`lib/deepl.js`):
  - `deeplBase(key) -> string`
  - `buildTranslateRequest({ text, targetLang, purpose }, key) -> { url, init }`
  - `mapDeeplError(status) -> { code, message }` — `status`가 0이면 네트워크 오류
- Produces (`background.js`):
  - `TRANSLATE {text, targetLang, purpose: 'bubble' | 'send'}` → `{ ok: true, text, detectedLang }` 또는 `{ ok: false, code, message }`. `code`는 `NO_KEY`, `BAD_KEY`, `QUOTA`, `RETRY`, `TOO_LONG` 중 하나
  - `CHECK_DEEPL_KEY` → `{ ok: true, used, limit }` 또는 `{ ok: false, code, message }` (`/v2/usage` 호출)

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`extension/test/deepl.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert');
const D = require('../lib/deepl.js');

test('free keys go to api-free, others to api', () => {
  assert.equal(D.deeplBase('abc:fx'), 'https://api-free.deepl.com');
  assert.equal(D.deeplBase('abc'), 'https://api.deepl.com');
});

test('bubble request has no source_lang', () => {
  const { url, init } = D.buildTranslateRequest({ text: 'Hello', targetLang: 'KO', purpose: 'bubble' }, 'k:fx');
  assert.equal(url, 'https://api-free.deepl.com/v2/translate');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'DeepL-Auth-Key k:fx');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), { text: ['Hello'], target_lang: 'KO' });
});

test('send request pins source_lang to KO', () => {
  const { init } = D.buildTranslateRequest({ text: '안녕하세요', targetLang: 'EN-US', purpose: 'send' }, 'k');
  assert.deepEqual(JSON.parse(init.body), { text: ['안녕하세요'], target_lang: 'EN-US', source_lang: 'KO' });
});

test('error mapping', () => {
  assert.equal(D.mapDeeplError(403).code, 'BAD_KEY');
  assert.equal(D.mapDeeplError(456).code, 'QUOTA');
  for (const s of [429, 500, 503, 0]) assert.equal(D.mapDeeplError(s).code, 'RETRY');
});
```

- [ ] **Step 2: 실패 확인** — Run: `node --test extension/test/deepl.test.js` / Expected: FAIL — module not found

- [ ] **Step 3: `lib/deepl.js`를 구현한다** — `message`는 기획서 7-3 오류 표의 문구를 그대로 쓴다.

- [ ] **Step 4: 통과 확인** — Run: `node --test extension/test/` / Expected: PASS

- [ ] **Step 5: `TRANSLATE`, `CHECK_DEEPL_KEY` 핸들러를 구현한다**

키가 없으면 `NO_KEY`, `text.length > 5000`이면 `TOO_LONG`. `fetch`에 `AbortController`로 10초 제한을 걸고 초과는 `RETRY`로 돌려준다. 응답의 `translations[0].text`와 `detected_source_language`를 돌려준다. 번역 요청은 직렬 큐 밖에서 실행한다(10초짜리 호출이 배지 보고를 막지 않게 한다).

- [ ] **Step 6: U8을 확인한다**

options의 [키 확인]을 눌러 사용량이 표시되는지 본다. service worker 콘솔에서 CORS 오류가 나면 기획서 7-4의 대체 경로("번역 중계 주소" 설정)를 이 Task에 추가하고, 결과를 기획서 3-6 표의 U8 줄에 "확인됨(날짜): 결과"로 적는다.

- [ ] **Step 7: 커밋** — `git add extension docs/etc/meta-inbox-extension-implementation-spec.md && git commit -m "Add DeepL translation in the service worker"`

---

### Task 4: content script 기반과 사전 검증 (U6, U7, U9, U10)

기획서 2-2, 3장, 12장. 이 Task의 검증 결과가 Task 5와 13의 구현 방식을 정한다.

**Files:**
- Create: `extension/content/selectors.js`, `extension/content/util.js`, `extension/content/content.css`, `extension/test/selectors.test.js`
- Modify: `extension/manifest.json`, `extension/background.js`, `docs/etc/meta-inbox-extension-implementation-spec.md` (3-6 표에 결과 기록)

**Interfaces:**
- Produces (`content/selectors.js`, `MBX.sel`):
  - `assetIdFrom(urlString, tabHrefs) -> string | null` — 주소의 `asset_id`, 없으면 채널 탭 href의 `asset_id` (순수 함수, node 테스트 대상)
  - `threadIdFrom(urlString) -> string | null` — `selected_item_id`
  - `channelFromPath(pathname) -> 'instagram_direct' | 'wec' | 'all' | 'other' | null` — `/latest/inbox`로 시작하지 않으면 `null`
  - `parseBadgeText(text) -> number` — 맨 앞 숫자, 없으면 0
  - DOM 조회: `channelTabs()`, `badgeOf(tabEl)`, `listContainer()`, `listItems()`, `listScrollTop()`, `messageRegion()`, `bubbleFrom(target)`, `bubbleTextEl(bubbleEl)`, `composer()`, `submitButton()`, `isSubmitButton(target)`, `searchValue()`
- Produces (`content/util.js`, `MBX.util`):
  - `send(type, payload) -> Promise<response>` — 실패하면 `{ ok: false, code: 'DISCONNECTED' }`를 돌려주고 "확장 프로그램이 갱신되었습니다. 페이지를 새로고침하세요"를 1회 표시
  - `connected() -> boolean`
  - `onMessage(type, fn)` — service worker가 보낸 `SETTINGS_CHANGED`, `WATCHER_ROLE` 수신
  - `settings() -> object | null` — 아직 못 받았으면 `null`
  - `host() -> ShadowRoot` — `mbx-root` 요소 아래의 Shadow DOM
  - `toast(text)`
  - `onInboxChange(fn)` — 경로, `asset_id`, `selected_item_id` 중 하나가 바뀌면 호출 (MutationObserver + 1초 간격 `location.href` 비교)
- Produces (`background.js`): port 연결 처리. content script가 `chrome.runtime.connect`로 연결하고 첫 메시지로 `HELLO {asset_id, path}`를 보내면 `{ settings, role }`로 답한다. 이 Task에서 `role`은 `assetId`가 비어 있으면 `'not_configured'`, 다르면 `'other_account'`, 같으면 `'standby'`다(담당 지정은 Task 12). `settings`와 `quickReplies`가 바뀌면 연결된 탭에 `SETTINGS_CHANGED`를 보낸다.

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`extension/test/selectors.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert');
const sel = require('../content/selectors.js').sel;
const U = 'https://business.facebook.com/latest/inbox/wec?asset_id=1234567890123456&business_id=9&selected_item_id=555&thread_type=x';

test('asset id from url, then from tab links, else null', () => {
  assert.equal(sel.assetIdFrom(U, []), '1234567890123456');
  assert.equal(sel.assetIdFrom('https://business.facebook.com/latest/inbox/wec', ['/latest/inbox/all?asset_id=42']), '42');
  assert.equal(sel.assetIdFrom('https://business.facebook.com/latest/inbox/wec', []), null);
});

test('thread id and channel', () => {
  assert.equal(sel.threadIdFrom(U), '555');
  assert.equal(sel.channelFromPath('/latest/inbox/wec'), 'wec');
  assert.equal(sel.channelFromPath('/latest/inbox/instagram_direct'), 'instagram_direct');
  assert.equal(sel.channelFromPath('/latest/inbox/all'), 'all');
  assert.equal(sel.channelFromPath('/latest/inbox/messenger'), 'other');
  assert.equal(sel.channelFromPath('/latest/home'), null);
});

test('badge text', () => {
  assert.equal(sel.parseBadgeText('2 new'), 2);
  assert.equal(sel.parseBadgeText('12 new  '), 12);
  assert.equal(sel.parseBadgeText(''), 0);
  assert.equal(sel.parseBadgeText(null), 0);
});
```

- [ ] **Step 2: 실패 확인** — Run: `node --test extension/test/selectors.test.js` / Expected: FAIL — module not found

- [ ] **Step 3: `selectors.js`, `util.js`를 구현하고 manifest에 content_scripts를 추가한다**

`selectors.js`는 DOM 조회 함수가 `document`를 함수 안에서만 참조하게 해 node에서 `require`할 수 있게 한다. 선택자 값은 기획서 3-2~3-5의 "확인됨" 항목을 쓴다. 문자열 기반 선택자(aria-label)는 `['Submit']`처럼 배열로 두어 한국어 값을 추가할 수 있게 한다. manifest의 `js` 순서: `lib/constants.js`, `lib/listcand.js`(Task 9에서 추가), `lib/sendgate.js`(Task 13에서 추가), `content/selectors.js`, `content/util.js`, 이후 기능 파일.

- [ ] **Step 4: 통과 확인** — Run: `node --test extension/test/` / Expected: PASS

- [ ] **Step 5: 수동 확인 (기반)**

- 수신함을 열면 service worker가 `HELLO`를 받고, 페이지 콘솔(확장 컨텍스트)에서 `MBX.util.settings()`에 비밀값이 없다.
- Business Suite 홈에서 수신함으로 이동해도 `onInboxChange`가 호출된다.
- `chrome://extensions`에서 확장을 다시 로드하면 기존 탭에 새로고침 안내가 1회 뜬다.
- options에서 빠른 메시지를 바꾸면 열린 수신함 탭이 `SETTINGS_CHANGED`를 받는다.

- [ ] **Step 6: 사전 검증 U6, U7, U9, U10을 수행하고 결과를 기록한다**

테스트용 상대 계정과의 대화에서, 확장 컨텍스트 콘솔로 확인한다.

| 항목 | 확인 방법 | 결과에 따른 결정 |
|-|-|-|
| U6 | 입력창에 포커스 → 합성 paste 이벤트(`text/plain`)로 "hello" 삽입 → 화면에 보이고 전송 버튼으로 실제 전송되는지. 안 되면 `document.execCommand('insertText')`로 같은 확인 | Task 5, 13의 삽입 1순위 방법 |
| U7 | 문구를 넣은 뒤 `MBX.sel.submitButton().click()`으로 전송되는지. 안 되면 합성 Enter keydown | 안 되면 Task 13은 "Enter 한 번 더" 방식(8-5의 4번)을 기본으로 한다 |
| U9 | `window`에 keydown, compositionend 로그 리스너를 capture로 걸고 한글 조합 중 Enter를 누른다. 이벤트 순서와 `isComposing`, `keyCode`, `key`, `code`를 기록. macOS에서 확인하고 Windows는 가능하면 확인 | Task 13의 조합 처리 분기 |
| U10 | 수신함 안에서 채널 탭·대화를 여러 번 바꾸며 `MBX.sel.assetIdFrom(location.href, ...)`이 `null`이 되는 순간이 있는지 | 있으면 Task 9의 계정 확인에 탭 링크 대체 경로를 반드시 쓴다 |

결과는 기획서 3-6 표의 각 줄에 "확인됨(날짜): 결과"로 적는다. U5(Instagram 전송 버튼 aria-label)와 U1(Instagram 목록 항목 구조)도 같은 자리에서 확인해 `selectors.js`에 반영한다.

- [ ] **Step 7: 커밋** — `git add extension docs/etc/meta-inbox-extension-implementation-spec.md && git commit -m "Add content script base and record pre-verification results"`

---

### Task 5: 입력창 막대, 빠른 메시지 삽입, 대화별 언어 (R6)

기획서 8-7, 9장, 8-2의 "설정 또는 대화별 언어를 아직 받지 못한 상태".

**Files:**
- Create: `extension/lib/threadlang.js`, `extension/test/threadlang.test.js`, `extension/content/composer.js`
- Modify: `extension/background.js`, `extension/manifest.json`, `extension/content/content.css`

**Interfaces:**
- Consumes: `MBX.util.*`, `MBX.sel.composer()`, `MBX.sel.threadIdFrom()`, Task 4의 U6 결과
- Produces (`lib/threadlang.js`): `setThreadLang(map, threadId, lang, now, cap) -> map` — 값은 `{ lang, at }`, `cap` 초과 시 `at`이 오래된 것부터 삭제. `getThreadLang(map, threadId, fallback) -> string`
- Produces (`background.js`): `SET_THREAD_LANG {threadId, lang}` → `{ ok: true }`, `GET_THREAD_LANG {threadId}` → `{ threadId, lang }` (없으면 `settings.sendTargetLang`)
- Produces (`content/composer.js`, `MBX.composer`):
  - `insertText(text, { replaceAll }) -> Promise<boolean>` — 입력창에 넣고 반영 여부를 돌려준다. `replaceAll`이 참이면 전체 선택 후 한 프레임 기다린 뒤 넣는다(8-5 교체 2번)
  - `currentLang() -> string | null` — 언어 코드, `'OFF'`, 불러오는 중이면 `null`
  - `text() -> string` — 입력창의 현재 텍스트

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`extension/test/threadlang.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert');
const T = require('../lib/threadlang.js');

test('set then get, fallback when missing', () => {
  const m = T.setThreadLang({}, 't1', 'OFF', 1000, 500);
  assert.equal(T.getThreadLang(m, 't1', 'EN-US'), 'OFF');
  assert.equal(T.getThreadLang(m, 't2', 'EN-US'), 'EN-US');
});

test('drops the oldest entries beyond the cap', () => {
  let m = {};
  m = T.setThreadLang(m, 'a', 'JA', 1, 2);
  m = T.setThreadLang(m, 'b', 'JA', 2, 2);
  m = T.setThreadLang(m, 'c', 'JA', 3, 2);
  assert.deepEqual(Object.keys(m).sort(), ['b', 'c']);
});
```

- [ ] **Step 2: 실패 확인** — Run: `node --test extension/test/threadlang.test.js` / Expected: FAIL — module not found

- [ ] **Step 3: `lib/threadlang.js`와 두 핸들러를 구현한다**

- [ ] **Step 4: 통과 확인** — Run: `node --test extension/test/` / Expected: PASS

- [ ] **Step 5: `composer.js`의 막대, 언어 버튼, 빠른 메시지 창, `insertText`를 구현한다**

- 막대는 `MBX.util.host()` 안에 두고 입력창의 `getBoundingClientRect` 위에 맞춘다. 입력창 높이 변화(`ResizeObserver`), 창 크기 변화, `onInboxChange`에서 위치를 다시 계산한다. Meta의 대화상자(`[role="dialog"]`)가 열려 있으면 숨긴다.
- 언어: 대화가 바뀌는 순간 `currentLang`을 `null`로 만들고 버튼에 "…"을 표시한 뒤 `GET_THREAD_LANG`을 보낸다. 응답의 `threadId`가 그 시점의 `threadIdFrom(location.href)`와 같을 때만 적용하고 다르면 버린다. 500ms 안에 응답이 없으면 다시 요청한다.
- 빠른 메시지 창: 제목과 본문 앞부분, 검색(제목·본문·태그), 방향키·Enter·Esc. 선택 시 `insertText(text, { replaceAll: false })` 후 입력창에 포커스. 전송하지 않는다. 항목이 없으면 9장의 안내와 설정 열기 링크.
- `insertText`: Task 4의 U6에서 통과한 방법을 1순위로, 다른 하나를 2순위로 쓴다. 500ms 안에 입력창 텍스트에 반영됐는지 확인해 결과를 돌려준다. `innerText` 대입 등 DOM 직접 수정은 쓰지 않는다.
- `quickRepliesEnabled`가 꺼져 있으면 [빠른 메시지] 버튼을 숨긴다.

- [ ] **Step 6: 수동 확인**

- 빠른 메시지를 고르면 입력창 커서 위치에 들어가고 전송되지 않는다. 이어서 직접 Enter를 누르면 Meta가 그대로 전송한다.
- 대화 A에서 언어를 "끔"으로, 대화 B에서 "JA"로 바꾼 뒤 A ↔ B를 오가면 각각의 값이 표시된다. 브라우저 재시작 후에도 유지된다.
- 영어 대화 → "끔" 대화 순으로 빠르게 연달아 바꿨을 때 "끔" 대화에 영어가 표시되지 않는다.
- 창 크기를 바꾸거나 입력창이 여러 줄로 늘어나도 막대가 입력창 위에 붙어 있다.

- [ ] **Step 7: 커밋** — `git add extension && git commit -m "Add composer bar, quick reply insertion and per-thread language"`

---

### Task 6: 말풍선 번역, 복사 버튼 (R2~R4)

기획서 7-1~7-3.

**Files:**
- Create: `extension/content/bubbles.js`
- Modify: `extension/manifest.json`, `extension/content/content.css`

**Interfaces:**
- Consumes: `MBX.sel.messageRegion()`, `MBX.sel.bubbleFrom(target)`, `MBX.sel.bubbleTextEl(bubbleEl)`, `MBX.util.send('TRANSLATE', { text, targetLang, purpose: 'bubble' })`, `MBX.util.host()`
- Produces: 없음(다른 Task가 쓰지 않는다)

- [ ] **Step 1: `bubbles.js`를 구현한다**

- 도구 모음은 1개만 만들어 재사용한다. `mouseover`에서 `bubbleFrom(event.target)`으로 말풍선을 찾고, 내용이 있는 본문 요소가 있을 때만 말풍선 위쪽 모서리에 표시한다. 이때 본문 텍스트는 읽지 않는다(존재와 비어 있는지만 본다).
- 말풍선과 도구 모음을 모두 벗어나면 300ms 뒤 숨기고, 스크롤 시 즉시 숨긴다.
- [복사]: 본문 요소의 `innerText`를 `navigator.clipboard.writeText`로 복사. 1.5초간 "복사됨", 실패 시 "복사 실패".
- [번역]: `TRANSLATE` 요청. 결과는 말풍선 아래의 상자(같은 Shadow DOM 안, 말풍선 위치를 따라감)에 "EN → KO"와 함께 표시. 다시 누르면 숨김. `detectedLang`이 `KO`면 "이미 한국어입니다". 진행 중 중복 클릭 방지.
- 캐시: `Map(data-message-id → { text, detectedLang })`, 최대 200개(초과 시 가장 먼저 넣은 것 삭제).
- 오류는 응답의 `code`별로 7-3 오류 표의 문구를 표시하고, `NO_KEY`에는 설정 열기 링크(`OPEN_OPTIONS`)를 붙인다.
- `bubbleButtonsEnabled`가 꺼져 있으면 아무것도 하지 않는다.

- [ ] **Step 2: 수동 확인** (기획서 13-3 R2~R4 전 항목)

- Instagram·WhatsApp 대화의 받은 말풍선, 보낸 말풍선 모두에 버튼이 나타난다.
- 사진·음성 말풍선에는 나타나지 않는다.
- 여러 줄·이모지 메시지의 복사 결과가 원문과 같고, 번역문이 표시돼 있어도 원문이 복사된다.
- 같은 말풍선을 다시 번역할 때 service worker의 Network에 DeepL 요청이 없다.
- 대화를 바꾸거나 위로 스크롤한 뒤에도 동작한다.
- DeepL 키를 비우면 설정 안내가, 잘못된 키면 "DeepL 키가 올바르지 않습니다"가 나온다.

- [ ] **Step 3: 커밋** — `git add extension && git commit -m "Add bubble translate and copy toolbar"`

---

### Task 7: R1 사전 확인 (U2~U4, U11, U12)

코드 변경 없이 실제 화면을 확인해 Task 8~12의 값을 확정한다. 기획서 3-6, 6-1.

**Files:**
- Modify: `docs/etc/meta-inbox-extension-implementation-spec.md` (3-6 표에 결과 기록), `extension/content/selectors.js` (확인된 선택자 반영), `extension/lib/constants.js` (값 조정)

- [ ] **Step 1: 아래를 테스트 대화로 확인하고 기획서 3-6 표에 기록한다**

| 항목 | 확인할 것 | 결과에 따른 결정 |
|-|-|-|
| U3 | 탭을 30분 가려 둔 뒤 메시지를 보냈을 때 배지와 목록이 갱신되는지 | 안 되면 6-6 운영 안내로 해결되는지 확인하고 기록 |
| U4 | 열어 둔 대화에 메시지가 오면 배지가 오르는지 | 안 오르면 목록 전용 알림 경로(Task 11)가 필수임을 기록 |
| U11 | 검색·필터가 켜진 상태의 판별 방법. "읽지 않음으로 표시" 메뉴의 위치와 배지 변화 | `MBX.sel.filterState()` 구현 방식, `userActionRecent`의 클릭 범위. 기능이 없으면 `userActionRecent`를 항상 `false`로 둔다 |
| U12 | 채널 탭 전환 시 배지가 잠깐 사라지는지 | 사라지지 않으면 `DROP_WAIT_MS`를 0으로 둔다 |
| U12 | 목록이 가상화되어 있는지(스크롤 시 항목이 DOM에서 사라지는지) | `listScrollTop()`의 대상 요소 확정 |
| U12 | 목록 항목이 여러 번에 나눠 바뀌는지 | 그렇다면 Task 9에서 가려진 탭의 즉시 판단에 "연속 두 번의 관찰에서 동일할 때만 후보" 규칙을 켠다 |
| U2 | `/latest/inbox/all`에 두 채널 대화가 함께 나오는지 | 기록만 한다(전제는 채널 탭 사용) |

- [ ] **Step 2: `selectors.js`에 `filterState() -> string`, `listScrollTop() -> number`, `isListOrThreadMenu(target) -> boolean`을 확정해 넣는다**

- [ ] **Step 3: 커밋** — `git add extension docs/etc/meta-inbox-extension-implementation-spec.md && git commit -m "Record inbox behaviour checks for Slack notices"`

---

### Task 8: 배지 기준값 판단 (service worker)

기획서 6-1 신호 1. 이 프로젝트에서 가장 틀리기 쉬운 로직이다. 처리 순서를 바꾸지 않는다.

**Files:**
- Create: `extension/lib/badge.js`, `extension/test/badge.test.js`
- Modify: `extension/background.js`

**Interfaces:**
- Produces (`lib/badge.js`): `applyBadgeReport(ch, value, now, dropWaitMs) -> { ch, event }`
  - `ch`: `{ base: number, known: boolean, pending: { value, at } | null }`
  - `event`: `null` 또는 `{ count: number }` (`count`는 받은 값 − 비교한 기준값)
  - 입력 객체를 바꾸지 않고 새 객체를 돌려준다
- Produces (`background.js`): 핸들러 `BADGE_STATE {asset_id, badges: {instagram_direct, wec}, initial, userActionRecent, at}`. `asset_id`가 `settings.assetId`와 다르면 버린다(담당 탭 검사는 Task 12에서 추가). 채널별로 `applyBadgeReport`를 적용해 저장하고, 이벤트가 있으면 `onBadgeEvent({ channel, count, kind, manualHint, at })`를 호출한다. `kind`는 `initial`이면 `'away'`, 아니면 `'new'`. `manualHint`는 `userActionRecent` 값. `onBadgeEvent`는 이 Task에서는 `console.debug`만 하고 Task 11에서 연결한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`extension/test/badge.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert');
const { applyBadgeReport } = require('../lib/badge.js');
const W = 3000;
const ch = (base, pending = null) => ({ base, known: true, pending });

test('first report ever only stores the baseline', () => {
  const r = applyBadgeReport({ base: 0, known: false, pending: null }, 4, 1000, W);
  assert.deepEqual(r, { ch: { base: 4, known: true, pending: null }, event: null });
});

test('increase creates one event with the difference', () => {
  const r = applyBadgeReport(ch(1), 3, 1000, W);
  assert.deepEqual(r, { ch: ch(3), event: { count: 2 } });
});

test('spec example 1: read everything, new message 10s later', () => {
  let r = applyBadgeReport(ch(2), 0, 0, W);
  assert.deepEqual(r, { ch: ch(2, { value: 0, at: 0 }), event: null });
  r = applyBadgeReport(r.ch, 1, 10000, W);
  assert.deepEqual(r, { ch: ch(1), event: { count: 1 } });
});

test('spec example 2: flicker returns within 3s, no event', () => {
  let r = applyBadgeReport(ch(2), 0, 0, W);
  r = applyBadgeReport(r.ch, 2, 1000, W);
  assert.deepEqual(r, { ch: ch(2), event: null });
});

test('spec example 3: new message during flicker', () => {
  let r = applyBadgeReport(ch(2), 0, 0, W);
  r = applyBadgeReport(r.ch, 3, 1000, W);
  assert.deepEqual(r, { ch: ch(3), event: { count: 1 } });
});

test('second decrease keeps the first timestamp and updates the value', () => {
  let r = applyBadgeReport(ch(3), 2, 0, W);
  r = applyBadgeReport(r.ch, 1, 1000, W);
  assert.deepEqual(r.ch, ch(3, { value: 1, at: 0 }));
});

test('pending is committed after 3s even when the value stays low', () => {
  let r = applyBadgeReport(ch(2), 0, 0, W);
  r = applyBadgeReport(r.ch, 0, 3001, W);
  assert.deepEqual(r, { ch: ch(0), event: null });
});

test('drop wait of 0 lowers the baseline on the next report', () => {
  let r = applyBadgeReport(ch(2), 0, 0, 0);
  r = applyBadgeReport(r.ch, 1, 1, 0);
  assert.deepEqual(r, { ch: ch(1), event: { count: 1 } });
});
```

- [ ] **Step 2: 실패 확인** — Run: `node --test extension/test/badge.test.js` / Expected: FAIL — module not found

- [ ] **Step 3: `applyBadgeReport`를 구현한다**

기획서 6-1 신호 1의 1~5번 순서를 그대로 옮긴다: ① `known`이 거짓이면 기준값만 저장하고 끝. ② `pending`이 있고 `now - pending.at > dropWaitMs`면 `base = pending.value`, `pending = null`. ③ 받은 값이 `base`보다 크면 이벤트를 만들고 `base`를 올리고 `pending`을 지운다. ④ 같으면 `pending`을 지운다. ⑤ 작으면 `pending`을 저장하되 이미 있으면 값만 바꾼다.

- [ ] **Step 4: 통과 확인** — Run: `node --test extension/test/` / Expected: PASS

- [ ] **Step 5: `BADGE_STATE` 핸들러를 구현하고 직렬 처리를 테스트로 고정한다**

핸들러 본체를 chrome API 없이 테스트할 수 있게 `handleBadgeState(state, msg, now) -> { state, events }` 순수 함수로 `lib/badge.js`에 두고, `background.js`는 저장소 읽기 → 이 함수 → 저장소 쓰기만 한다. `extension/test/badge.test.js`에 추가:

```js
const { handleBadgeState } = require('../lib/badge.js');
const { createSerialQueue } = require('../lib/serial.js');

test('reports applied through the serial queue equal sequential application', async () => {
  let stored = { channels: { instagram_direct: { base: 0, known: true, pending: null }, wec: { base: 0, known: true, pending: null } } };
  const events = [];
  const run = createSerialQueue();
  const report = (wec, at, delay) => run(async () => {
    const snapshot = stored;                              // read
    await new Promise(r => setTimeout(r, delay));         // slow storage
    const r = handleBadgeState(snapshot, { badges: { instagram_direct: 0, wec }, initial: false, userActionRecent: false, at }, at);
    stored = r.state; events.push(...r.events);           // write
  });
  await Promise.all([report(1, 0, 20), report(2, 10, 1), report(3, 20, 1)]);
  assert.equal(stored.channels.wec.base, 3);
  assert.deepEqual(events.map(e => e.count), [1, 1, 1]);
});

test('initial report above the baseline becomes an away event', () => {
  const state = { channels: { instagram_direct: { base: 0, known: true, pending: null }, wec: { base: 1, known: true, pending: null } } };
  const r = handleBadgeState(state, { badges: { instagram_direct: 0, wec: 4 }, initial: true, userActionRecent: false, at: 0 }, 0);
  assert.deepEqual(r.events, [{ channel: 'wec', count: 3, kind: 'away', manualHint: false, at: 0 }]);
});
```

- [ ] **Step 6: 통과 확인** — Run: `node --test extension/test/` / Expected: PASS

- [ ] **Step 7: 커밋** — `git add extension && git commit -m "Add badge baseline logic with drop wait"`

---

### Task 9: 목록 후보와 watcher (content script)

기획서 6-1 관찰, 안정화, 신호 2, 계정 확인.

**Files:**
- Create: `extension/lib/listcand.js`, `extension/test/listcand.test.js`, `extension/content/watcher.js`
- Modify: `extension/manifest.json`, `extension/background.js`

**Interfaces:**
- Consumes: `MBX.sel.*`(Task 4, 7), `MBX.util.send`, `MBX.util.onInboxChange`
- Produces (`lib/listcand.js`):
  - `parseItemLines(lines) -> { name, preview, time } | null` — 기획서 3-3의 줄 순서(이름, 미리보기, 날짜 단어, 시각, 라벨)
  - `isTodayTime(time) -> boolean` — "1:59 PM" 같은 시:분 형태
  - `isOwnMessage(preview) -> boolean` — `"You: "`로 시작
  - `isTyping(preview) -> boolean`
  - `itemKey({ channel, name, preview, time }) -> string` — FNV-1a 32비트 해시의 16진 문자열
  - `findCandidates(items, known) -> { candidates, reset }` — `items`는 위에서부터 최대 15개(`{channel, name, preview, time, key}`), `known`은 `Set<string>`
  - `remember(known, keys, cap) -> void` — `Set`의 삽입 순서를 이용해 `cap` 초과 시 오래된 것부터 삭제
- Produces (`content/watcher.js`): service worker로 `BADGE_STATE`, `LIST_CANDIDATE {asset_id, channel, sender, preview, time, at}`, `HEARTBEAT {asset_id, ok, reason, path, badges}`를 보낸다. `WATCHER_ROLE`을 받아 `owner`일 때만 `BADGE_STATE`와 `HEARTBEAT`를 보낸다.
- Produces (`background.js`): 핸들러 `LIST_CANDIDATE`. `asset_id`가 맞으면 `onListCandidate(cand)`를 호출한다(Task 11에서 연결, 이 Task에서는 `console.debug`).

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`extension/test/listcand.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib/listcand.js');
const it = (name, preview, time = '1:59 PM') => { const o = { channel: 'wec', name, preview, time }; return { ...o, key: L.itemKey(o) }; };
const known = (...items) => new Set(items.map(i => i.key));

test('parseItemLines follows the confirmed line order', () => {
  assert.deepEqual(L.parseItemLines(['Hong Gildong', '예약 가능한가요', 'Today', '1:59 PM', 'Follow up']), { name: 'Hong Gildong', preview: '예약 가능한가요', time: '1:59 PM' });
  assert.deepEqual(L.parseItemLines(['821012345678', 'hi', 'Wednesday', 'Wed']), { name: '821012345678', preview: 'hi', time: 'Wed' });
  assert.equal(L.parseItemLines(['only name']), null);
});

test('time and preview classifiers', () => {
  assert.equal(L.isTodayTime('1:59 PM'), true);
  assert.equal(L.isTodayTime('13:05'), true);
  assert.equal(L.isTodayTime('Wed'), false);
  assert.equal(L.isOwnMessage('You: 네'), true);
  assert.equal(L.isTyping('Typing…'), true);
});

test('a new item above every known item is a candidate', () => {
  const a = it('A', 'old'), b = it('B', 'old');
  const r = L.findCandidates([it('C', 'new'), a, b], known(a, b));
  assert.deepEqual(r.candidates.map(c => c.name), ['C']);
  assert.equal(r.reset, false);
});

test('an existing thread with a new preview is a candidate', () => {
  const a = it('A', 'old'), b = it('B', 'old');
  const r = L.findCandidates([it('B', 'new one'), a], known(a, b));
  assert.deepEqual(r.candidates.map(c => c.preview), ['new one']);
});

test('an item that slid up from below after move-to-done is not a candidate', () => {
  const a = it('A', 'x'), b = it('B', 'x');
  const r = L.findCandidates([a, b, it('P', 'from below')], known(a, b));
  assert.deepEqual(r.candidates, []);
});

test('own messages, typing, and non-today items are skipped', () => {
  const a = it('A', 'x');
  const r = L.findCandidates([it('B', 'You: 네'), it('C', 'Typing…'), it('D', 'hi', 'Wed'), a], known(a));
  assert.deepEqual(r.candidates, []);
  assert.equal(r.reset, false);
});

test('no known item in view means the list was replaced', () => {
  const r = L.findCandidates([it('X', '1'), it('Y', '2')], known(it('A', 'x')));
  assert.deepEqual(r, { candidates: [], reset: true });
});

test('four or more candidates at once also reset', () => {
  const a = it('A', 'x');
  const r = L.findCandidates([it('P', '1'), it('Q', '2'), it('R', '3'), it('S', '4'), a], known(a));
  assert.deepEqual(r, { candidates: [], reset: true });
});

test('remember keeps at most cap keys, dropping the oldest', () => {
  const k = new Set(['1', '2']);
  L.remember(k, ['3', '4'], 3);
  assert.deepEqual([...k], ['2', '3', '4']);
});
```

- [ ] **Step 2: 실패 확인** — Run: `node --test extension/test/listcand.test.js` / Expected: FAIL — module not found

- [ ] **Step 3: `lib/listcand.js`를 구현한다**

`findCandidates`: 목록에서 `known`에 있는 첫 항목의 위치를 찾는다. 없으면 `reset`. 그 위치보다 위에 있고, 키가 `known`에 없고, 내 메시지·입력 중이 아니고, `isTodayTime`인 항목이 후보다. 후보가 4개 이상이면 `reset`.

- [ ] **Step 4: 통과 확인** — Run: `node --test extension/test/` / Expected: PASS

- [ ] **Step 5: `watcher.js`를 구현한다**

- 관찰: 채널 탭 영역과 목록 컨테이너에 `MutationObserver`. 보조로 60초마다 1회 직접 조회.
- 계정 확인: 보고를 만들 때마다 `MBX.sel.assetIdFrom(location.href, 탭 href들)`을 읽는다. `settings.assetId`와 다르면 보고하지 않고 "알림 대상 계정이 아닙니다"를, 비어 있으면 "설정에서 알림 대상 계정을 지정하세요 [설정 열기]"를 작게 표시한다. `asset_id`를 60초 이상 못 읽으면 `HEARTBEAT {ok: false, reason: 'no_asset_id'}`.
- 안정화: 상태는 `'load'`(20초), `'change'`(3초), `'ready'`. 진입 조건은 페이지 로드, 로그인 복귀, 대상 계정 화면 복귀(이상 `'load'`), 화면 조건 변경(경로 + `searchValue()` + `filterState()`), 목록이 맨 위로 돌아옴, `findCandidates`의 `reset`(이상 `'change'`). 배지와 목록에 변화가 없는 시간이 기준을 넘으면 `'ready'`가 되고 그때의 목록 키를 `remember`한다.
- 배지: `owner`일 때, 두 채널 배지 값이 바뀌면 즉시 `BADGE_STATE`를 보낸다. `'load'` 안정화 중에는 보내지 않고, 끝난 뒤 첫 보고에 `initial: true`. `'change'` 안정화 중에는 계속 보낸다. `userActionRecent`는 직전 2초 안에 `MBX.sel.isListOrThreadMenu(target)`인 클릭이 있었는지다.
- 목록: 대상 계정의 수신함 탭이면 담당 여부와 관계없이 수행한다. `listScrollTop() === 0`이고 `'ready'`일 때만 `findCandidates`를 호출한다. 내려가 있는 동안에는 보이는 항목을 `remember`만 한다. `document.visibilityState === 'visible'`이면 1.5초 디바운스 후, 아니면 관찰자 콜백에서 바로 판단한다(Task 7에서 "나눠 바뀜"이 확인됐으면 가려진 탭에서는 같은 후보가 연속 두 번의 관찰에서 동일할 때만 보낸다). 후보마다 `LIST_CANDIDATE`를 보내고 현재 목록 키를 `remember`한다.
- 생존 신호: `owner`일 때 30초마다 `HEARTBEAT`. `ok`는 수신함 경로이고 `asset_id`를 읽었고 채널 탭과 목록 컨테이너를 찾았을 때 참. `'load'` 안정화 중에는 `badges`를 싣지 않는다. 로그인 화면 또는 선택자 실패가 60초 이상이면 `ok: false`와 `reason`(`'login'`, `'selector'`)을 보낸다.
- 보안 확인·로그인·캡차 화면에서는 모든 기능을 멈춘다(금지 사항 9).

- [ ] **Step 6: 수동 확인**

service worker 콘솔의 `console.debug`로 확인한다(Slack 전송은 Task 10~11). 이 Task에서는 `role`이 `standby`뿐이므로 `watcher.js`의 담당 조건을 임시로 무시하는 디버그 플래그(`localStorage` 사용 금지, 코드 상수 `DEBUG_FORCE_OWNER`)를 두고, Task 12에서 제거한다.

- 테스트 계정에서 메시지를 보내면 `BADGE_STATE`와 `LIST_CANDIDATE`가 각각 1번 온다.
- 내가 답장을 보내면 `LIST_CANDIDATE`가 오지 않는다.
- 채널 탭 전환, 검색, 필터, 목록 스크롤(조금 내렸다 올리기 포함), 대화 완료 처리 중 `LIST_CANDIDATE`가 오지 않는다.
- 다른 계정 화면에서는 아무 보고도 오지 않고 화면에 안내가 뜬다.

- [ ] **Step 7: 커밋** — `git add extension && git commit -m "Add list candidate detection and inbox watcher"`

---

### Task 10: Slack 메시지 형식, 전송, 재시도, 중복 방지

기획서 6-2, 6-3, 6-4.

**Files:**
- Create: `extension/lib/slack.js`, `extension/test/slack.test.js`
- Modify: `extension/background.js`, `extension/options/options.js`

**Interfaces:**
- Produces (`lib/slack.js`):
  - 대기열 항목(`QueueItem`): `{ id, type: 'badge' | 'list' | 'supplement' | 'system', channel, count, kind: 'new' | 'away', manualHint, sender, preview, time, text, createdAt, status: 'hold' | 'ready', holdUntil, attempts, nextTryAt }` — `system`은 중단·재개 경고와 테스트 메시지이고 `text`만 쓴다
  - `maskPhone(name) -> string`
  - `escapeSlackText(s) -> string`
  - `buildSlackPayload(item, settings, now) -> { text, blocks }`
  - `dedupKey(item, now) -> string`
  - `isDuplicate(sentKeys, key, now) -> boolean` — `sentKeys`는 `[{ key, at }]`, 10분 이내면 참
  - `pruneSentKeys(sentKeys, now) -> sentKeys` — 24시간 지난 것 삭제
  - `classifyStatus(status) -> 'ok' | 'retry' | 'config'` — 200은 ok, 0·429·5xx는 retry, 그 외 4xx는 config
  - `nextRetryDelayMs(attempts, retryAfterSec) -> number`
- Produces (`background.js`):
  - `enqueue(item) -> Promise<void>` — `slackQueue`에 저장. Webhook 주소가 비어 있거나 `slackEnabled`가 꺼져 있으면 넣지 않고 `lastError`에 설정 필요 상태를 기록
  - `flushQueue(now) -> Promise<void>` — `status: 'ready'`이고 `nextTryAt <= now`인 항목을 전송. 24시간 지난 항목은 폐기. 메시지 수신 시, 알람(`mbx-tick`, 1분 간격)에서, service worker 시작 시 호출
  - 핸들러 `SEND_TEST_SLACK` → `{ ok, status }`

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`extension/test/slack.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert');
const K = require('../lib/slack.js');
const settings = { accountName: '', slackPreviewMaxLen: 100, slackMaskPhone: true };
const base = { id: '1', type: 'badge', channel: 'wec', count: 1, kind: 'new', manualHint: false, sender: 'Hong Gildong', preview: '예약 가능한 시간이 궁금합니다', time: '2:02 PM', createdAt: 0 };
const allText = (p) => JSON.stringify(p);

test('maskPhone keeps the last four digits of numeric names only', () => {
  assert.equal(K.maskPhone('821012345678'), '********5678');
  assert.equal(K.maskPhone('+82 10-1234-5678'), '+** **-****-5678');
  assert.equal(K.maskPhone('Hong Gildong'), 'Hong Gildong');
});

test('escapeSlackText escapes &, <, >', () => {
  assert.equal(K.escapeSlackText('a & <b>'), 'a &amp; &lt;b&gt;');
});

test('detailed notice: channel label, sender, preview, inbox link without thread id', () => {
  const p = K.buildSlackPayload(base, settings, 0);
  assert.match(p.text, /^\[WhatsApp\] 새 메시지/);
  assert.match(p.text, /보낸 사람: Hong Gildong/);
  assert.match(p.text, /내용: 예약 가능한 시간이 궁금합니다/);
  assert.match(p.text, /https:\/\/business\.facebook\.com\/latest\/inbox\/wec/);
  assert.doesNotMatch(p.text, /selected_item_id/);
  assert.ok(Array.isArray(p.blocks) && p.blocks.length > 0);
});

test('account name is prefixed when set', () => {
  const p = K.buildSlackPayload(base, { ...settings, accountName: '테스트의원' }, 0);
  assert.match(p.text, /^\[테스트의원\]\[WhatsApp\] 새 메시지/);
});

test('count-only notice names where to look and shows the count', () => {
  const p = K.buildSlackPayload({ ...base, channel: 'instagram_direct', count: 3, sender: null, preview: null }, settings, 0);
  assert.match(p.text, /^\[Instagram\] 새 메시지 3건/);
  assert.match(p.text, /수신함의 Instagram 탭에서 확인하세요/);
});

test('manual hint is added only to count-only notices', () => {
  const countOnly = K.buildSlackPayload({ ...base, manualHint: true, sender: null, preview: null }, settings, 0);
  assert.match(countOnly.text, /수동으로 읽지 않음 표시한 것일 수 있음/);
  const detailed = K.buildSlackPayload({ ...base, manualHint: true }, settings, 0);
  assert.doesNotMatch(detailed.text, /수동으로 읽지 않음/);
});

test('away, supplement and unsupported-type wording', () => {
  assert.match(K.buildSlackPayload({ ...base, kind: 'away', count: 4, sender: null, preview: null }, settings, 0).text, /자리 비운 사이 새 메시지 4건/);
  const sup = K.buildSlackPayload({ ...base, type: 'supplement' }, settings, 0);
  assert.match(sup.text, /방금 \[WhatsApp\] 알림의 상세/);
  assert.doesNotMatch(sup.text, /새 메시지/);
  assert.match(K.buildSlackPayload({ ...base, preview: "*Message can't be displayed* ..." }, settings, 0).text, /수신함에서 표시되지 않는 유형입니다\. WhatsApp Business 앱에서 확인하세요/);
});

test('preview is cut to slackPreviewMaxLen and phone names are masked', () => {
  const p = K.buildSlackPayload({ ...base, sender: '821012345678', preview: 'Z'.repeat(300) }, settings, 0);
  assert.match(p.text, /보낸 사람: \*{8}5678/);
  assert.equal((p.text.match(/Z/g) || []).length, 100);
});

test('customer text cannot trigger mentions or links', () => {
  const p = K.buildSlackPayload({ ...base, sender: '<!here>', preview: '<!channel> <https://evil.example|click> & more' }, settings, 0);
  assert.doesNotMatch(p.text, /<!channel>|<!here>|<https:\/\/evil/);
  assert.match(p.text, /&lt;!channel&gt;/);
  const customerBlocks = p.blocks.flatMap(b => [b.text, ...(b.fields || []), ...(b.elements || [])].filter(Boolean));
  for (const t of customerBlocks) if (/channel|here|evil/.test(t.text)) assert.equal(t.type, 'plain_text');
  assert.ok(allText(p).includes('evil.example'));
});

test('dedup key: same detailed item matches, badge-only key changes per minute and value', () => {
  assert.equal(K.dedupKey(base, 0), K.dedupKey({ ...base, id: '2' }, 999999));
  const b = { ...base, sender: null, preview: null, count: 2 };
  assert.equal(K.dedupKey(b, 60000), K.dedupKey(b, 119999));
  assert.notEqual(K.dedupKey(b, 60000), K.dedupKey(b, 120000));
  assert.notEqual(K.dedupKey(b, 0), K.dedupKey({ ...b, count: 3 }, 0));
});

test('duplicate window is 10 minutes, sent keys expire after 24h', () => {
  const keys = [{ key: 'k', at: 0 }];
  assert.equal(K.isDuplicate(keys, 'k', 599999), true);
  assert.equal(K.isDuplicate(keys, 'k', 600001), false);
  assert.deepEqual(K.pruneSentKeys(keys, 86400001), []);
});

test('status classes and retry schedule', () => {
  assert.equal(K.classifyStatus(200), 'ok');
  for (const s of [0, 429, 500, 503]) assert.equal(K.classifyStatus(s), 'retry');
  for (const s of [400, 403, 404]) assert.equal(K.classifyStatus(s), 'config');
  assert.deepEqual([0, 1, 2, 3, 9].map(a => K.nextRetryDelayMs(a, null)), [30000, 120000, 600000, 600000, 600000]);
  assert.equal(K.nextRetryDelayMs(0, 45), 45000);
});
```

- [ ] **Step 2: 실패 확인** — Run: `node --test extension/test/slack.test.js` / Expected: FAIL — module not found

- [ ] **Step 3: `lib/slack.js`를 구현한다**

메시지 문구는 기획서 6-2의 예시와 6-0, 6-1의 문장을 그대로 쓴다. 채널 표기는 `wec` → `WhatsApp`, `instagram_direct` → `Instagram`. `blocks`에서 고객이 쓴 문자열(발신자, 미리보기)이 들어가는 text 객체는 모두 `plain_text`다. 배지 전용 중복 키의 분 단위 시각은 `Math.floor(now / 60000)`이다.

- [ ] **Step 4: 통과 확인** — Run: `node --test extension/test/` / Expected: PASS

- [ ] **Step 5: `enqueue`, `flushQueue`, `SEND_TEST_SLACK`을 구현한다**

- 전송 직전에 `dedupKey`와 `isDuplicate`로 중복을 걸러 폐기하고, 성공하면 키를 `sentKeys`에 넣는다(`system` 항목은 중복 검사를 하지 않는다).
- 결과가 `retry`면 `attempts`를 올리고 `nextTryAt = now + nextRetryDelayMs(attempts, Retry-After 값)`. `config`면 대기열에서 빼고 `lastError`에 기록하며 확장 아이콘 배지에 "!"를 표시한다.
- 재시도 시각은 `chrome.alarms`의 1분 알람에서 확인한다(가장 짧은 30초 재시도는 다음 알람 또는 다음 메시지 수신 때 처리된다). `setTimeout`으로 재시도하지 않는다.
- `fetch`는 직렬 큐 밖에서 실행하고, 결과 반영(대기열 수정)만 큐 안에서 한다.

- [ ] **Step 6: 수동 확인**

- [테스트 메시지 보내기]가 Slack 채널에 도착한다.
- Webhook 주소 끝을 틀리게 바꾸면 options 상태와 아이콘 배지에 오류가 표시되고 재시도하지 않는다.
- 네트워크를 끊고 테스트 메시지를 보낸 뒤 복구하면 몇 분 안에 도착한다.

- [ ] **Step 7: 커밋** — `git add extension && git commit -m "Add Slack formatting, delivery, retry and dedup"`

---

### Task 11: 결합, 보류, 보충 메시지

기획서 6-1 "결합과 보류".

**Files:**
- Create: `extension/lib/combine.js`, `extension/test/combine.test.js`
- Modify: `extension/background.js`

**Interfaces:**
- Consumes: `QueueItem`(Task 10), `enqueue`·`flushQueue`(Task 10), `onBadgeEvent`(Task 8), `onListCandidate`(Task 9)
- Produces (`lib/combine.js`): 세 함수 모두 `st = { queue, recent }`를 받아 새 `st`를 돌려준다. `recent`는 `[{ channel, at, remaining }]`.
  - `routeBadgeEvent(st, ev, now, newId) -> st` — `ev`는 `{ channel, count, kind, manualHint, at }`
  - `routeCandidate(st, cand, now, newId) -> st` — `cand`는 `{ channel, sender, preview, time, at }`
  - `releaseDue(st, now) -> st` — `holdUntil <= now`인 `hold` 항목을 `ready`로 바꾸고, 상세 정보 없이 풀린 배지 항목을 `recent`에 `{ channel, at: now, remaining: count }`로 기록하며, 2분 지난 `recent`를 지운다
- Produces (`background.js`): `onBadgeEvent`, `onListCandidate`를 위 함수에 연결. 보류 항목을 만든 직후 `setTimeout(5000)`으로 `releaseDue` + `flushQueue`를 예약하고, service worker 시작 시·모든 메시지 수신 시·알람에서도 `releaseDue`를 호출한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`extension/test/combine.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/combine.js');
let n = 0; const id = () => 'id' + (++n);
const empty = () => ({ queue: [], recent: [] });
const ev = (o = {}) => ({ channel: 'wec', count: 1, kind: 'new', manualHint: false, at: 0, ...o });
const cand = (o = {}) => ({ channel: 'wec', sender: 'Hong', preview: 'hi', time: '2:02 PM', at: 0, ...o });

test('badge event is held for 5 seconds', () => {
  const st = C.routeBadgeEvent(empty(), ev(), 1000, id);
  assert.equal(st.queue.length, 1);
  assert.deepEqual([st.queue[0].type, st.queue[0].status, st.queue[0].holdUntil], ['badge', 'hold', 6000]);
});

test('candidate within the hold joins the badge event and is released at once', () => {
  let st = C.routeBadgeEvent(empty(), ev(), 1000, id);
  st = C.routeCandidate(st, cand(), 2000, id);
  assert.equal(st.queue.length, 1);
  assert.deepEqual([st.queue[0].sender, st.queue[0].preview, st.queue[0].status], ['Hong', 'hi', 'ready']);
});

test('candidate first, badge event within 5s joins it', () => {
  let st = C.routeCandidate(empty(), cand(), 1000, id);
  assert.deepEqual([st.queue[0].type, st.queue[0].status, st.queue[0].holdUntil], ['list', 'hold', 6000]);
  st = C.routeBadgeEvent(st, ev({ count: 2 }), 3000, id);
  assert.equal(st.queue.length, 1);
  assert.deepEqual([st.queue[0].count, st.queue[0].sender, st.queue[0].status], [2, 'Hong', 'ready']);
});

test('a candidate for another channel does not join', () => {
  let st = C.routeBadgeEvent(empty(), ev({ channel: 'instagram_direct' }), 1000, id);
  st = C.routeCandidate(st, cand({ channel: 'wec' }), 2000, id);
  assert.equal(st.queue.length, 2);
});

test('badge event released without detail is recorded for supplements', () => {
  let st = C.routeBadgeEvent(empty(), ev({ count: 1 }), 1000, id);
  st = C.releaseDue(st, 6000);
  assert.equal(st.queue[0].status, 'ready');
  assert.deepEqual(st.recent, [{ channel: 'wec', at: 6000, remaining: 1 }]);
});

test('late candidate within 2 minutes becomes one supplement, the next one a new notice', () => {
  let st = C.releaseDue(C.routeBadgeEvent(empty(), ev({ count: 1 }), 1000, id), 6000);
  st = C.routeCandidate(st, cand(), 60000, id);
  assert.deepEqual([st.queue[1].type, st.queue[1].status], ['supplement', 'ready']);
  assert.equal(st.recent[0].remaining, 0);
  st = C.routeCandidate(st, cand({ sender: 'Kim' }), 61000, id);
  assert.deepEqual([st.queue[2].type, st.queue[2].status], ['list', 'hold']);
});

test('a held badge event takes priority over a recent count notice', () => {
  let st = C.releaseDue(C.routeBadgeEvent(empty(), ev(), 1000, id), 6000);
  st = C.routeBadgeEvent(st, ev(), 20000, id);
  st = C.routeCandidate(st, cand(), 21000, id);
  assert.equal(st.queue.filter(q => q.type === 'supplement').length, 0);
  assert.equal(st.queue[1].sender, 'Hong');
  assert.equal(st.recent[0].remaining, 1);
});

test('candidate after the 2 minute window is a new notice and the record is dropped', () => {
  let st = C.releaseDue(C.routeBadgeEvent(empty(), ev(), 1000, id), 6000);
  st = C.releaseDue(st, 6000 + 120001);
  assert.deepEqual(st.recent, []);
  st = C.routeCandidate(st, cand(), 6000 + 120002, id);
  assert.equal(st.queue[st.queue.length - 1].type, 'list');
});

test('list-only item is released as a detailed notice and leaves no supplement record', () => {
  let st = C.releaseDue(C.routeCandidate(empty(), cand(), 1000, id), 6000);
  assert.equal(st.queue[0].status, 'ready');
  assert.deepEqual(st.recent, []);
});
```

- [ ] **Step 2: 실패 확인** — Run: `node --test extension/test/combine.test.js` / Expected: FAIL — module not found

- [ ] **Step 3: `lib/combine.js`를 구현한다**

`routeCandidate`의 순서는 기획서 그대로다: ① 같은 채널에 상세 정보가 없는 보류 배지 항목이 있으면 합쳐 `ready`로. ② 없고 같은 채널의 `recent`가 2분 이내이며 `remaining > 0`이면 `supplement` 항목을 `ready`로 넣고 `remaining`을 1 줄인다. ③ 둘 다 아니면 `list` 항목을 5초 보류로 넣는다. `kind: 'away'` 이벤트는 보류하지 않고 바로 `ready`로 넣으며 `recent`에 기록하지 않는다.

- [ ] **Step 4: 통과 확인** — Run: `node --test extension/test/` / Expected: PASS

- [ ] **Step 5: `background.js`에 연결하고 수동 확인한다**

- 보고 있는 채널에 메시지: 발신자와 미리보기가 있는 알림 1건.
- 보고 있지 않은 채널에 메시지: "N건" 알림 1건, 확인할 위치 문구 포함.
- Instagram 탭과 WhatsApp 탭을 하나씩 열고 가려진 쪽 채널에 메시지: 알림 1건, 또는 건수 알림 + "알림의 상세" 보충 1건. "새 메시지"가 두 번 오지 않는다.
- 배지 이벤트 보류 중(5초 안)에 `chrome://serviceworker-internals`에서 service worker를 중지해도, 다음 생존 신호 때 알림이 도착한다.
- 같은 채널에 메시지 2건이 연달아 왔을 때 상세 정보가 올바른 알림에 붙는다.

- [ ] **Step 6: 커밋** — `git add extension && git commit -m "Combine badge events with list candidates and add supplements"`

---

### Task 12: 감지 담당 탭, 감지 중단 경고, 알림 대상 지정

기획서 6-1 "감지 담당 탭", 6-5, 10-4.

**Files:**
- Create: `extension/lib/owner.js`, `extension/lib/watchdog.js`, `extension/test/owner.test.js`, `extension/test/watchdog.test.js`
- Modify: `extension/background.js`, `extension/content/watcher.js` (`DEBUG_FORCE_OWNER` 제거), `extension/options/options.js`

**Interfaces:**
- Produces (`lib/owner.js`): `chooseOwner(currentOwnerId, tabs, assetId, now, timeoutMs) -> number | null` — `tabs`는 `[{ tabId, assetId, path, lastSeen }]`. 후보는 `assetId`가 같고 `path`가 `/latest/inbox`로 시작하는 탭. 현재 담당이 후보이고 `now - lastSeen <= timeoutMs`면 유지, 아니면 `lastSeen`이 가장 최근인 후보
- Produces (`lib/watchdog.js`):
  - `onHeartbeat(ws, now) -> { ws, alert }` — `alert`는 `null` 또는 `'resumed'`
  - `watchdogTick(ws, assetId, now) -> { ws, alert }` — `alert`는 `null` 또는 `'stopped'`. `ws`는 `watcherState`
- Produces (`background.js`):
  - 연결된 탭 목록 `tabsSeen`(저장소 키, `HELLO`·`HEARTBEAT`·port 끊김·`chrome.tabs.onRemoved`에서 갱신)
  - `HELLO` 응답의 `role`이 `'owner'` 또는 `'standby'`로 확정되고, 담당이 바뀌면 관련 탭에 `WATCHER_ROLE`을 보낸다
  - `BADGE_STATE`, `HEARTBEAT`는 보낸 탭이 담당일 때만 처리한다. `HEARTBEAT`에 `badges`가 있으면 `BADGE_STATE`와 같은 경로로 비교한다(`initial: false`, `userActionRecent: false`)
  - 핸들러 `SET_ASSET_FROM_OPEN_TAB` → `{ ok: true, assetId }` 또는 `{ ok: false, code: 'NO_INBOX_TAB' }` 또는 `{ ok: false, code: 'MULTIPLE', assetIds }`
  - 핸들러 `GET_STATUS` → `{ lastHeartbeat, lastSend, queueLength, lastError, assetId, ownerTabId }`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`extension/test/owner.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { chooseOwner } = require('../lib/owner.js');
const T = 90000;
const tab = (tabId, o = {}) => ({ tabId, assetId: '42', path: '/latest/inbox/wec', lastSeen: 0, ...o });

test('keeps the current owner while it is eligible and alive', () => {
  assert.equal(chooseOwner(1, [tab(1, { lastSeen: 50000 }), tab(2, { lastSeen: 99000 })], '42', 100000, T), 1);
});

test('hands over when the owner is silent for more than 90s', () => {
  assert.equal(chooseOwner(1, [tab(1, { lastSeen: 0 }), tab(2, { lastSeen: 95000 })], '42', 100000, T), 2);
});

test('hands over when the owner left the inbox or switched account, or is gone', () => {
  assert.equal(chooseOwner(1, [tab(1, { path: '/latest/home' }), tab(2)], '42', 0, T), 2);
  assert.equal(chooseOwner(1, [tab(1, { assetId: '99' }), tab(2)], '42', 0, T), 2);
  assert.equal(chooseOwner(1, [tab(2)], '42', 0, T), 2);
});

test('no eligible tab means no owner', () => {
  assert.equal(chooseOwner(1, [tab(3, { assetId: '99' })], '42', 0, T), null);
  assert.equal(chooseOwner(null, [], '42', 0, T), null);
});
```

`extension/test/watchdog.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const W = require('../lib/watchdog.js');
const ws = (o = {}) => ({ lastHeartbeat: 0, everSeen: true, stoppedAlertSent: false, lastAlarmAt: 0, ...o });
const MIN = 60000;

test('no watching before the first heartbeat or without a target account', () => {
  assert.equal(W.watchdogTick(ws({ everSeen: false, lastAlarmAt: 9 * MIN }), '42', 10 * MIN).alert, null);
  assert.equal(W.watchdogTick(ws({ lastAlarmAt: 9 * MIN }), '', 10 * MIN).alert, null);
});

test('stopped alert once after more than 3 minutes of silence', () => {
  const r = W.watchdogTick(ws({ lastHeartbeat: 0, lastAlarmAt: 3 * MIN }), '42', 4 * MIN);
  assert.equal(r.alert, 'stopped');
  assert.equal(r.ws.stoppedAlertSent, true);
  assert.equal(W.watchdogTick(r.ws, '42', 5 * MIN).alert, null);
});

test('no alert at exactly 3 minutes', () => {
  assert.equal(W.watchdogTick(ws({ lastHeartbeat: MIN, lastAlarmAt: 3 * MIN }), '42', 4 * MIN).alert, null);
});

test('after a gap of 3 minutes or more between alarms, skip one round', () => {
  const r = W.watchdogTick(ws({ lastHeartbeat: 0, lastAlarmAt: MIN }), '42', 60 * MIN);
  assert.equal(r.alert, null);
  assert.equal(r.ws.lastAlarmAt, 60 * MIN);
  assert.equal(W.watchdogTick(r.ws, '42', 61 * MIN).alert, 'stopped');
});

test('heartbeat after a stopped alert reports resumed once', () => {
  const r = W.onHeartbeat(ws({ stoppedAlertSent: true }), 9 * MIN);
  assert.equal(r.alert, 'resumed');
  assert.deepEqual([r.ws.stoppedAlertSent, r.ws.lastHeartbeat, r.ws.everSeen], [false, 9 * MIN, true]);
  assert.equal(W.onHeartbeat(r.ws, 10 * MIN).alert, null);
});
```

- [ ] **Step 2: 실패 확인** — Run: `node --test extension/test/` / Expected: FAIL — `owner.js`, `watchdog.js` module not found

- [ ] **Step 3: `lib/owner.js`, `lib/watchdog.js`를 구현한다**

- [ ] **Step 4: 통과 확인** — Run: `node --test extension/test/` / Expected: PASS

- [ ] **Step 5: `background.js`와 options에 연결한다**

- 1분 알람(`mbx-tick`)에서 `watchdogTick` → 경고가 있으면 `system` 항목을 `enqueue`("감지가 중단되었습니다. 수신함 탭을 확인하세요" / "감지가 재개되었습니다"). 같은 알람에서 `chooseOwner`도 다시 계산한다.
- `HEARTBEAT {ok: false, reason}`이면 원인을 담은 경고 `system` 항목을 1회 넣는다(`reason`별로 재개 전까지 1번).
- `lastHeartbeat`는 `ok: true`인 신호만 갱신한다. 대상 계정이 아닌 화면만 열려 있으면 신호가 없으므로 3분 뒤 중단 경고가 나간다.
- `SET_ASSET_FROM_OPEN_TAB`: `tabsSeen`에서 수신함 경로인 탭들의 `assetId`를 모은다. 0개면 `NO_INBOX_TAB`, 값이 하나면 저장, 여러 값이면 `MULTIPLE`과 목록(options가 고르게 한다).
- options 상태 영역에 `GET_STATUS` 결과를 표시하고 5초마다 갱신한다.
- `watcher.js`의 `DEBUG_FORCE_OWNER`를 지운다.

- [ ] **Step 6: 수동 확인** (기획서 13-3 R1 중 담당·중단 관련)

- [현재 수신함을 알림 대상으로 지정]으로 asset_id가 채워지고, 수신함 탭이 없으면 "수신함을 먼저 여세요"가 나온다.
- 수신함 탭을 2개 열고 메시지를 보내면 알림이 1건만 온다.
- 담당 탭을 닫은 직후 메시지를 보내면 다른 탭이 이어받아 알림이 온다.
- service worker를 중지했다 다시 시작해도 `ownerTabId`가 유지된다.
- 모든 수신함 탭을 닫으면 3~4분 안에 중단 경고가, 다시 열면 재개 알림과 "자리 비운 사이" 알림이 온다.
- 로그아웃 상태에서 경고가 온다.
- PC를 5분 이상 재웠다 깨웠을 때 중단·재개 알림이 불필요하게 오지 않는다.

- [ ] **Step 7: 커밋** — `git add extension && git commit -m "Add watcher ownership, stop warning and target account setup"`

---

### Task 13: 한글 입력 번역 전송 (R5)

기획서 8장 전체. 원칙은 "실패하면 전송하지 않는다"이다. Task 4의 U6, U7, U9 결과를 먼저 읽는다.

**Files:**
- Create: `extension/lib/sendgate.js`, `extension/test/sendgate.test.js`
- Modify: `extension/content/composer.js`, `extension/manifest.json`, `extension/content/content.css`

**Interfaces:**
- Consumes: `MBX.composer.insertText`, `MBX.composer.currentLang`, `MBX.composer.text`(Task 5), `MBX.util.send('TRANSLATE', { text, targetLang, purpose: 'send' })`, `MBX.util.connected()`, `MBX.sel.isSubmitButton`, `MBX.sel.submitButton`
- Produces (`lib/sendgate.js`):
  - `hasHangul(s) -> boolean` — 가-힣, ㄱ-ㅎ, ㅏ-ㅣ
  - `decideSend(ctx) -> 'pass' | 'swallow' | 'block_loading' | 'block_disconnected' | 'intercept'`
    - `ctx`: `{ text, bypass, busy, connected, settingsLoaded, langLoaded, enabled, lang, lastTranslated }`
  - `isEnterKey(e) -> boolean` — `e.key === 'Enter'` 또는 `e.code`가 `'Enter'`, `'NumpadEnter'`
  - `hasModifier(e) -> boolean` — Shift, Ctrl, Alt, Meta
  - `isComposingEvent(e) -> boolean` — `e.isComposing` 또는 `e.keyCode === 229`
  - `normalizeForCompare(s) -> string`

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`extension/test/sendgate.test.js`)

```js
const test = require('node:test');
const assert = require('node:assert');
const G = require('../lib/sendgate.js');
const ctx = (o = {}) => ({ text: '안녕하세요', bypass: false, busy: false, connected: true, settingsLoaded: true, langLoaded: true, enabled: true, lang: 'EN-US', lastTranslated: null, ...o });

test('hasHangul covers syllables and bare jamo', () => {
  for (const s of ['가', 'ㅋㅋ', 'ㅏ', 'ok 네']) assert.equal(G.hasHangul(s), true);
  for (const s of ['hello', '日本語', '😀', '']) assert.equal(G.hasHangul(s), false);
});

test('Korean text with everything ready is intercepted', () => {
  assert.equal(G.decideSend(ctx()), 'intercept');
});

test('the continuation send the extension itself fires passes through', () => {
  assert.equal(G.decideSend(ctx({ bypass: true, busy: true })), 'pass');
});

test('a second Enter while translating is swallowed, never passed to Meta', () => {
  assert.equal(G.decideSend(ctx({ busy: true })), 'swallow');
  assert.equal(G.decideSend(ctx({ busy: true, text: 'hello' })), 'swallow');
});

test('text without Hangul always passes, even before settings arrive', () => {
  assert.equal(G.decideSend(ctx({ text: 'hello', settingsLoaded: false, langLoaded: false, connected: false })), 'pass');
});

test('Korean text is blocked until settings and the thread language arrive', () => {
  assert.equal(G.decideSend(ctx({ settingsLoaded: false })), 'block_loading');
  assert.equal(G.decideSend(ctx({ langLoaded: false })), 'block_loading');
});

test('Korean text passes untranslated when translation is off', () => {
  assert.equal(G.decideSend(ctx({ enabled: false })), 'pass');
  assert.equal(G.decideSend(ctx({ lang: 'OFF' })), 'pass');
});

test('Korean text is blocked when the extension context is gone and translation is on', () => {
  assert.equal(G.decideSend(ctx({ connected: false })), 'block_disconnected');
});

test('unchanged translation result with leftover Hangul passes on the second press', () => {
  assert.equal(G.decideSend(ctx({ text: 'Visit 강남 clinic', lastTranslated: 'Visit 강남 clinic' })), 'pass');
  assert.equal(G.decideSend(ctx({ text: 'Visit 강남 clinic!', lastTranslated: 'Visit 강남 clinic' })), 'intercept');
});

test('key helpers', () => {
  assert.equal(G.isEnterKey({ key: 'Enter', code: 'Enter' }), true);
  assert.equal(G.isEnterKey({ key: 'Process', code: 'Enter' }), true);
  assert.equal(G.isEnterKey({ key: 'Process', code: 'NumpadEnter' }), true);
  assert.equal(G.isEnterKey({ key: 'a', code: 'KeyA' }), false);
  assert.equal(G.hasModifier({ shiftKey: true }), true);
  assert.equal(G.hasModifier({}), false);
  assert.equal(G.isComposingEvent({ isComposing: true }), true);
  assert.equal(G.isComposingEvent({ keyCode: 229 }), true);
  assert.equal(G.isComposingEvent({ keyCode: 13 }), false);
});

test('normalizeForCompare ignores whitespace differences but not content', () => {
  const a = 'Hello,  world 😀\r\n\r\nSecond line here ';
  const b = 'Hello, world 😀\nSecond line here';
  assert.equal(G.normalizeForCompare(a), G.normalizeForCompare(b));
  assert.notEqual(G.normalizeForCompare('Hello world'), G.normalizeForCompare('Hello  word'));
});
```

- [ ] **Step 2: 실패 확인** — Run: `node --test extension/test/sendgate.test.js` / Expected: FAIL — module not found

- [ ] **Step 3: `lib/sendgate.js`를 구현한다**

`decideSend`의 판정 순서: ① `bypass` → `pass`. ② `busy` → `swallow`. ③ 한글 없음 → `pass`. ④ `settingsLoaded`가 거짓 → `block_loading`. ⑤ `enabled`가 거짓 → `pass`. ⑥ `langLoaded`가 거짓 → `block_loading`. ⑦ `lang === 'OFF'` → `pass`. ⑧ `text === lastTranslated` → `pass`. ⑨ `connected`가 거짓 → `block_disconnected`. ⑩ 그 외 → `intercept`.

- [ ] **Step 4: 통과 확인** — Run: `node --test extension/test/` / Expected: PASS

- [ ] **Step 5: `composer.js`에 가로채기를 구현한다**

- 리스너 등록: `window`에 capture 단계로 `keydown`, `keypress`, `keyup`, `click`, `mousedown`, `pointerdown`, `compositionend`를 건다. 스크립트 최상단(document_start)에서 등록하고, 수신함 경로가 아니거나 `sendTranslateEnabled`가 꺼져 있으면 리스너 안에서 즉시 반환한다.
- Enter(`isEnterKey`이고 `hasModifier`가 아니고 target이 입력창 안)와 전송 버튼(`MBX.sel.isSubmitButton(target)`) 모두 `decideSend` 결과로 분기한다. `pass`가 아니면 `preventDefault` + `stopImmediatePropagation`. `block_loading`은 "번역 설정을 불러오는 중입니다. 잠시 후 다시 시도하세요"를 표시하고 설정·언어를 다시 요청한다. `block_disconnected`는 새로고침 안내를 표시한다.
- 조합 중 Enter(`isComposingEvent`): `stopImmediatePropagation`만 호출하고 `preventDefault`는 호출하지 않는다. "전송 대기"를 켜고(500ms 뒤 자동 해제, 입력창 포커스 이탈·대화 변경 시 즉시 해제), `compositionend` 또는 뒤따르는 조합 아님 Enter 중 먼저 온 쪽에서 한 프레임 기다린 뒤 흐름을 1회 시작한다. Task 4의 U9 결과에서 확인된 이벤트 순서에 맞춘다.
- 번역 흐름(8-1): `busy`를 켜고 입력창 위에 "번역 중" 표시(Meta 요소의 스타일은 바꾸지 않고 겹쳐 그린다) → `TRANSLATE`(10초 제한) → 시작 시점의 대화 번호와 입력창 텍스트가 그대로인지 확인 → `insertText(번역문, { replaceAll: true })` → `normalizeForCompare`로 입력창과 번역문 비교 → `lastTranslated`를 기록 → 번역문에 한글이 없으면 전송 이어가기.
- 전송 이어가기(8-5): `bypass`를 1000ms 켜고 `MBX.sel.submitButton().click()`(버튼이 없으면 합성 Enter keydown). 1.5초 안에 입력창이 비면 성공, 아니면 "번역되었습니다. Enter를 한 번 더 눌러 전송하세요". U7이 불가능으로 확인됐으면 이어가기를 건너뛰고 이 안내를 기본으로 한다.
- 실패 처리는 기획서 8-6 표 그대로다. 어떤 실패에서도 전송하지 않는다. 교체 실패 시 가능하면 원문을 `insertText(원문, { replaceAll: true })`로 복원한다.
- 전송 성공 직후 한글 원문을 막대 아래에 5초간 작게 보여 준다. 저장하지 않는다.
- `lastTranslated`는 전송이 끝나거나, 대화가 바뀌거나, 입력창이 비워지면 지운다.

- [ ] **Step 6: 수동 확인** (기획서 13-3 R5 전 항목, 테스트용 상대 계정에서만)

- 한글 입력 후 Enter, 전송 버튼 각각: 상대 계정에 번역문만 1건 도착한다.
- 한글·영어 혼합, 여러 줄(Shift+Enter), 이모지 포함: 줄바꿈이 유지된다.
- 한글 조합 중 Enter를 빠르게 눌렀을 때 글자 누락이나 이중 전송이 없다.
- 한글이 없는 입력은 번역 없이 그대로 전송된다.
- 대상 언어 "끔"일 때 한글이 그대로 전송된다.
- "끔"인 대화로 바꾼 직후 바로 한글을 전송했을 때 번역되지 않고, 언어를 불러오기 전에는 전송이 막힌다.
- DeepL 키를 틀리게 한 뒤 전송하면 전송되지 않고 원문이 입력창에 남는다.
- 번역 중 다른 대화로 이동하면 아무것도 전송되지 않는다.
- 번역 중 Enter를 연타해도 한글 원문이 나가지 않는다.
- 확장 프로그램을 다시 로드한 뒤 기존 탭에서 한글을 전송하면 막히고 새로고침 안내가 나온다.
- 빠른 메시지(한글)를 넣고 전송하면 번역되어 나간다.

- [ ] **Step 7: 커밋** — `git add extension && git commit -m "Add translate-on-send for Korean input"`

---

### Task 14: 전체 확인과 문서

**Files:**
- Modify: `README.md` (메인 제품 절의 상태 줄), `docs/etc/meta-slack-notification-design.md` (상단에 표시 한 줄)

- [ ] **Step 1: 자동 테스트 전체 실행**

Run: `node --test extension/test/`
Expected: 전부 PASS, 실패 0

- [ ] **Step 2: 기획서 13-3의 R1 항목 전체를 수동으로 실행한다**

Task 9~12에서 이미 확인한 것을 포함해 목록 순서대로 다시 실행하고, 각 항목의 결과를 PR 설명에 체크 목록으로 남긴다. 특히 다음은 앞 Task에서 다루지 않았다.

- 같은 문구 반복, 10초 안에 연속 3건
- 탭을 30분 이상 가려 둔 뒤 수신
- 미리보기에 `@channel`, `<링크>` 형태 문자열이 있을 때 Slack에서 동작하지 않는지
- 배지 2인 상태에서 모두 읽고 10초 뒤 새 메시지가 왔을 때 알림이 오는지
- "읽지 않음으로 표시"를 했을 때 수동 표시 안내가 붙는지
- 목록을 오래 내려 둔 사이 메시지가 오고, 맨 위로 돌아왔을 때 알림이 한 번 더 나가지 않는지

- [ ] **Step 3: 금지 사항 점검**

Run: `grep -rnE "XMLHttpRequest|WebSocket|document\.cookie|history\.(pushState|replaceState)|world: *['\"]MAIN|localStorage|innerText *=[^=]" extension --include=*.js --exclude-dir=test`
Expected: 출력 없음

Run: `grep -rnE "fetch\(|chrome\.storage" extension/content`
Expected: 출력 없음

Run: `grep -n "permissions" -A 8 extension/manifest.json`
Expected: `storage`, `alarms`, `clipboardWrite`와 host 4개만 있다

- [ ] **Step 4: 문서를 고친다**

- `README.md` 맨 위 메인 제품 절의 "상태: 구현 전" 줄을 실제 상태로 고친다(테스트 명령은 이미 있다). 레거시 절은 건드리지 않는다.
- `docs/etc/meta-slack-notification-design.md` 맨 위(제목 아래)에 한 줄을 넣는다: `> 구현 기획서(meta-inbox-extension-implementation-spec.md)에서 서버 경유가 아닌 Slack 직접 전송으로 확정했다. 이 문서는 검토 배경으로만 본다.`

- [ ] **Step 5: 커밋** — `git add README.md docs/etc/meta-slack-notification-design.md && git commit -m "Document the Meta inbox extension tests and the delivery decision"`

---

## 기획서 요구사항과 Task 대응

| 요구사항 | Task |
|-|-|
| R1 Slack 알림 | 7, 8, 9, 10, 11, 12 |
| R2~R4 말풍선 번역·복사 | 3, 6 |
| R5 번역 전송 | 3, 4(사전 검증), 5, 13 |
| R6 빠른 메시지 사용 | 5 |
| R7 빠른 메시지 관리 | 2 |
| 금지 사항(4장), 권한(2-2) | Global Constraints, 14 |
| 미확인 항목 U1~U12 | 3(U8), 4(U1, U5, U6, U7, U9, U10), 7(U2, U3, U4, U11, U12) |
