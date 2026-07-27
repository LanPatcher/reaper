/**
 * `node:events`, or the part of it the transport uses.
 *
 * `Transport extends EventEmitter` and the bridge listens with `.on()`. That
 * is the whole requirement — no `once`, no `prependListener`, no max-listener
 * warnings — so this is the small honest version rather than a reimplementation
 * of Node's, which carries a decade of behaviour nothing here depends on.
 *
 * The one thing it does take seriously is that a throwing listener must not
 * take down the emit. In the transport, `emit("peers", …)` runs inside socket
 * handling; a listener that throws there would propagate into the frame reader,
 * which destroys the connection. That failure mode has already been found once
 * in this codebase — a local bug presenting as the *peer* being broken — and it
 * is worth not reintroducing on a platform where it is harder to observe.
 */
type Listener = (...args: never[]) => void;

export class EventEmitter {
  #listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): this {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapper = ((...args: never[]) => {
      this.off(event, wrapper);
      listener(...args);
    }) as Listener;

    return this.on(event, wrapper);
  }

  off(event: string, listener: Listener): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  removeListener(event: string, listener: Listener): this {
    return this.off(event, listener);
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const set = this.#listeners.get(event);
    if (!set || set.size === 0) return false;

    // Copied before iterating: a listener that removes itself — `once` does —
    // would otherwise mutate the set mid-loop.
    for (const listener of [...set]) {
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch (error) {
        // Reported, not propagated. See the note above: this runs inside
        // socket handling, and letting it out closes the connection.
        console.error(`[events] listener for "${event}" threw:`, error);
      }
    }

    return true;
  }

  listenerCount(event: string): number {
    return this.#listeners.get(event)?.size ?? 0;
  }
}

export default { EventEmitter };
