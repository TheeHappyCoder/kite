/** Prevent list snapshots taken during a write from undoing optimistic UI changes. */
export function createMailChanges() {
  let revision = 0;
  let pending = 0;
  return {
    begin() {
      revision++;
      pending++;
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        pending--;
        revision++;
      };
    },
    snapshot() {
      const started = revision;
      const idle = pending === 0;
      return () => idle && pending === 0 && revision === started;
    },
  };
}

export const mailChanges = createMailChanges();
