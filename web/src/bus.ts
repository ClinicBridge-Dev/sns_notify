import type { MessageDTO, SseTranslationEvent } from './types';

/** App → 열린 대화 화면으로 실시간 이벤트를 전달하는 작은 이벤트 버스 */
export type BusEvent =
  | { type: 'message'; message: MessageDTO }
  | { type: 'translation'; event: SseTranslationEvent }
  | { type: 'resync' };

export interface Bus {
  emit(e: BusEvent): void;
  subscribe(fn: (e: BusEvent) => void): () => void;
}

export function createBus(): Bus {
  const subs = new Set<(e: BusEvent) => void>();
  return {
    emit(e) {
      subs.forEach((fn) => fn(e));
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}
