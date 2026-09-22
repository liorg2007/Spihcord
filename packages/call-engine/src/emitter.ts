/** Tiny typed event emitter. Handler exceptions never propagate to the emitter. */
export type Unsubscribe = () => void;

export class Emitter<Events extends object> {
  private handlers = new Map<keyof Events, Set<(payload: never) => void>>();

  constructor(private readonly onHandlerError?: (err: unknown) => void) {}

  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): Unsubscribe {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    const h = handler as (payload: never) => void;
    set.add(h);
    return () => {
      set!.delete(h);
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of [...set]) {
      try {
        (h as (payload: Events[K]) => void)(payload);
      } catch (err) {
        this.onHandlerError?.(err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
