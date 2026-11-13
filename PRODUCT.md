# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(A Chrome Manifest V3 extension that runs inside Meta Business Suite in desktop Chrome. No mobile, no store distribution; loaded unpacked.)

## Users

ClinicBridge counselors (상담원) who answer foreign patients' Instagram DMs and WhatsApp messages on behalf of partner clinics. They work all day inside the Meta Business Suite inbox (business.facebook.com/latest/inbox), one Business Suite account for now. Customers write mostly in English; counselors write in Korean.

Secondary audience: the roughly six staff who never open the extension but read its new-message alerts in a Slack channel.

## Product Purpose

Meta Inbox Helper (name used in the extension UI) makes the Meta inbox workable for Korean-speaking counselors and keeps new inquiries from being missed:

- R1: posts an alert to Slack when a new Instagram or WhatsApp message arrives (channel always; sender and preview when visible).
- R2–R4: a floating toolbar on each chat bubble to translate it into Korean (DeepL) or copy the original.
- R5: counselors type in Korean and press Send/Enter; the text is translated to the conversation's target language and only the translation is sent.
- R6–R7: quick messages (saved replies) inserted at the cursor, managed with JSON import/export on the options page.

Success: no inquiry goes unnoticed, and no Korean original is ever sent to a customer.

## Positioning

A thin assistant layer on Meta's own inbox, not a replacement inbox. It uses only what Meta already renders on screen (no Meta API, no server), calls Slack and DeepL directly from the extension, and refuses to act on its own: it never opens, clicks, scrolls, or sends anything the counselor did not trigger.

## Operating Context

- Counselors keep an Instagram tab and/or a WhatsApp tab of the inbox open all day; the tab they work in doubles as the detector. Navigating away from the inbox stops detection.
- Injected UI sits on top of Meta's interface (around a ~400px-wide composer and the message list) and must coexist with Meta's popups and re-renders. Meta's DOM changes without notice.
- One browser is the designated Slack-alert browser; others turn Slack off to avoid duplicate posts.
- Settings (Slack webhook, DeepL key, languages, quick messages, status) live on the extension's options page, opened in a new tab.

## Capabilities and Constraints

- Prohibitions (spec §4) outrank features: no Meta internal API/GraphQL/websocket interception; no reading cookies or sessions; no auto-opening, clicking, scrolling, or refreshing; no reading bubble text the user did not click; no sending without a user send action; no data to anywhere but Slack and DeepL; no persistent message storage beyond dedupe/queue; stop everything on login, security-check, or captcha screens; never delete or alter Meta's DOM except the composer for R5/R6.
- Failure rule for R5: if translation or replacement fails, do not send.
- Plain JavaScript, no build tools or libraries. Injected UI renders in a Shadow DOM under a single fixed host element (`mbx-root`); it reuses one floating toolbar rather than injecting into every bubble.
- Selectors live in one file; when elements cannot be found the extension shows a status rather than failing silently.
- Terminology: 빠른 메시지 (quick messages), 말풍선 (bubble), 감지 담당 탭 (detecting tab), 수신함 (inbox), 번역 전송 (send translation).
- Status: implemented with automated tests, not yet verified on the live Meta screen (manual checks U1–U12, R1–R7 pending).
- Out of scope: multiple accounts, history collection, auto-replies, bulk translation, attachments, Messenger and comment inboxes, mobile.
- Legacy code (`app/`, `web/` viewer, `chrome-extension/`, `mac/`) is frozen: bug fixes only, not a design surface.

## Brand Commitments

- UI language is Korean; product name "Meta Inbox Helper".
- Spec §8-7: when translate-send is on, the composer shows it with an overlaid border drawn by the extension (Meta's element styles are never changed), and the last sent Korean original shows under the composer bar for 5 seconds.

## Evidence on Hand

- Spec of record: `docs/etc/meta-inbox-extension-implementation-spec.md` (v1.8).
- Manual check list: `docs/etc/meta-inbox-extension-manual-checks.md`.
- Icons: `extension/icons/` (16, 48, 128).
- No user research, metrics, or testimonials exist; do not invent them.

## Product Principles

1. Safe by default: when unsure, don't send, don't click, don't read. A missed translation beats a Korean message sent to a patient.
2. Stay out of Meta's way: augment the inbox without breaking or masking it; Meta's UI remains the primary surface.
3. Always say what state you're in: translate-send on/off, target language, detection health, and errors are visible, never silent.
4. Fast in the flow of a conversation: every helper works from the keyboard and inside the counselor's current conversation, without switching tabs.

## Accessibility & Inclusion

No product-specific requirements established. Spec requires injected controls to be real `button` elements with aria-labels and keyboard support (quick-message list: arrows, Enter, Esc).
