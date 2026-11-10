// 대화별 마지막으로 읽은 seq (브라우저별, localStorage). 저장소가 막혀 있어도 동작해야 한다.

const KEY = 'lw:lastRead:v1';

interface Stored {
  /** 첫 방문 시 기존 대화를 모두 읽음으로 초기화했는지 */
  seeded: boolean;
  seqs: Record<string, number>;
}

function load(): Stored {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { seeded: false, seqs: {} };
    const v = JSON.parse(raw) as Partial<Stored>;
    return {
      seeded: !!v.seeded,
      seqs: v.seqs && typeof v.seqs === 'object' ? v.seqs : {},
    };
  } catch {
    return { seeded: false, seqs: {} };
  }
}

function save(s: Stored): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 저장 실패는 무시 (이번 세션 메모리에만 유지)
  }
}

let state: Stored | null = null;

export type ReadMap = Readonly<Record<string, number>>;

export function getReadMap(): ReadMap {
  if (!state) state = load();
  return state.seqs;
}

/**
 * 이 브라우저의 첫 방문이면 현재 목록 전체를 읽음 처리한다(처음부터 전부 점이 찍히는 것 방지).
 * 이후에는 기록이 없는 대화 = 새로 생긴 대화이므로 안 읽음으로 본다.
 */
export function seedIfFirstVisit(convs: { id: number; last_seq: number }[]): ReadMap {
  getReadMap();
  if (state!.seeded) return state!.seqs;
  const seqs = { ...state!.seqs };
  for (const c of convs) {
    const k = String(c.id);
    if (seqs[k] === undefined) seqs[k] = c.last_seq;
  }
  state = { seeded: true, seqs };
  save(state);
  return seqs;
}

/** seq가 기존 값보다 클 때만 갱신. 새 맵을 반환(변경 없으면 같은 객체). */
export function markRead(conversationId: number, seq: number): ReadMap {
  getReadMap();
  const k = String(conversationId);
  if ((state!.seqs[k] ?? -Infinity) >= seq) return state!.seqs;
  state = { ...state!, seqs: { ...state!.seqs, [k]: seq } };
  save(state);
  return state.seqs;
}

export function isUnread(
  map: ReadMap,
  conv: { id: number; last_seq: number; last_message: unknown },
): boolean {
  if (conv.last_message == null) return false;
  const v = map[String(conv.id)];
  return v === undefined ? true : conv.last_seq > v;
}
