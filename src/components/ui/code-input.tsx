"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "../icon";

// A row of digit cells that is one field (adapted from Bencho's "One-time code" block). One
// invisible input sits over the row, so paste, autofill and backspace stay the browser's; the cells
// are drawn underneath. A right code slides the cells together under a blur-and-threshold filter
// until they fuse into one capsule; a wrong one shivers down the row and the digits drain out.
// Everything that moves is written straight to the DOM from one rAF loop that parks itself when
// still, so typing never re-renders more than the digits.

const W = 36; // a cell
const H = 44;
const G = 7; // the air between two
const CAP = 132; // the capsule a right code becomes
const POP_MS = 260;
const SHAKE_MS = 620;
const CHECK_MS = 420;
/** How long "Unlocked" (or the like) shows on the settled capsule before `onDone`. */
const HOLD_MS = 420;
/** The merge is a spring a little under critical, so the capsule overshoots once and settles round. */
const MERGE = (() => {
  const k = 0.09;
  const zeta = 0.62;
  return { k, d: 1 - 2 * zeta * Math.sqrt(k) };
})();

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, v: number) => {
  const u = clamp((v - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
};
const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

type Phase = "type" | "check" | "ok" | "no";

export function CodeInput({
  length,
  mask = false,
  label,
  okLabel = "Verified",
  corner = 12,
  autoFocus = false,
  onSubmit,
  onDone,
  onType,
}: {
  /** Digits in the code: the row checks itself when full. */
  length: number;
  /** Draw dots instead of digits (PINs). */
  mask?: boolean;
  label: string;
  okLabel?: string;
  corner?: number;
  autoFocus?: boolean;
  /** Checks a full row: true fuses it into the capsule, false shakes and clears it. */
  onSubmit: (code: string) => Promise<boolean>;
  /** After the capsule has settled. */
  onDone?: () => void;
  onType?: () => void;
}) {
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<Phase>("type");
  const [focus, setFocus] = useState(false);
  const n = length;
  const rowW = n * W + (n - 1) * G;
  const r = clamp(corner, 0, H / 2);

  const input = useRef<HTMLInputElement>(null);
  const cells = useRef<(HTMLSpanElement | null)[]>([]);
  const slots = useRef<(HTMLSpanElement | null)[]>([]);
  const capsule = useRef<HTMLSpanElement>(null);
  const caretEl = useRef<HTMLElement>(null);
  const okEl = useRef<HTMLSpanElement>(null);

  // Moving parts, read by the loop.
  const motion = useRef({
    caret: { x: W / 2, v: 0 },
    merge: { m: 0, v: 0, to: 0 },
    popAt: [] as number[],
    shookAt: -Infinity,
    /** A right code: `onDone` once the capsule has come to rest. */
    doneWhenSettled: false,
    raf: 0,
    still: false,
    live: { code: "", n, phase: "type" as Phase, rowW },
  });
  const timers = useRef<number[]>([]);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  const goo = `code-goo-${useId().replace(/:/g, "")}`;

  /** Writes this frame's positions to the DOM; true while something still moves. */
  const paint = (now: number, dt: number) => {
    const s = motion.current;
    const { code: c, n: count, phase: ph, rowW: width } = s.live;
    let busy = false;

    const target = Math.min(c.length, count - 1) * (W + G) + W / 2;
    const k = s.caret;
    if (s.still) Object.assign(k, { x: target, v: 0 });
    else {
      k.v = (k.v + (target - k.x) * 0.2 * dt) * Math.pow(0.62, dt);
      k.x += k.v * dt;
      if (Math.abs(target - k.x) < 0.05 && Math.abs(k.v) < 0.05) Object.assign(k, { x: target, v: 0 });
      else busy = true;
    }

    const mg = s.merge;
    if (mg.m !== mg.to || mg.v !== 0) {
      if (s.still) Object.assign(mg, { m: mg.to, v: 0 });
      else {
        mg.v = (mg.v + (mg.to - mg.m) * MERGE.k * dt) * Math.pow(MERGE.d, dt);
        mg.m += mg.v * dt;
        if (Math.abs(mg.to - mg.m) < 0.0008 && Math.abs(mg.v) < 0.0008) Object.assign(mg, { m: mg.to, v: 0 });
        else busy = true;
      }
    }

    const m = clamp(mg.m, 0, 1);
    const over = mg.m - 1;
    const mid = (width - W) / 2;
    const since = now - s.shookAt;
    const shaking = ph === "no" && since < SHAKE_MS && !s.still;
    if (ph === "no" && since < SHAKE_MS + 200 + count * 45 + 220) busy = true;
    if (ph === "check" && !s.still) busy = true;
    const shake = (i: number) => (shaking ? 5 * Math.exp(-since / 190) * Math.sin((since / 1000) * Math.PI * 20 + i * 0.55) : 0);
    const x = (i: number) => mix(i * (W + G), mid, m) + shake(i);
    const scale = (i: number) => {
      if (ph === "check" && !s.still) {
        const u = ((now % 900) / 900) * (count + 2) - i;
        return 1 - 0.07 * (u > 0 && u < 2 ? Math.sin((u / 2) * Math.PI) : 0);
      }
      const at = s.popAt[i];
      if (at === undefined) return 1;
      const u = (now - at) / POP_MS;
      if (u < 1) busy = true;
      return u > 0 && u < 1 ? 1 + 0.04 * Math.sin(Math.PI * u) : 1;
    };
    const cellR = mix(r, H / 2, smooth(0.15, 0.7, m));

    for (let i = 0; i < count; i++) {
      const cell = cells.current[i];
      if (cell) {
        cell.style.borderRadius = `${cellR}px`;
        cell.style.transform = `translateX(${x(i).toFixed(2)}px) scale(${scale(i).toFixed(3)})`;
      }
      const slot = slots.current[i];
      if (slot) {
        slot.style.transform = `translateX(${x(i).toFixed(2)}px)`;
        slot.style.opacity = String(1 - smooth(0, 0.45, m));
        const digit = slot.firstElementChild as HTMLElement | null;
        if (digit) {
          // A wrong code drains right to left.
          const out = ph === "no" && !s.still ? smooth(0, 1, (since - 300 - (count - 1 - i) * 45) / 220) : 0;
          digit.style.translate = `0 ${(out * 8).toFixed(2)}px`;
          digit.style.opacity = String(1 - out);
        }
      }
    }
    const capW = CAP * smooth(0.3, 1, m) * (1 + Math.max(-0.12, over) * 0.6);
    if (capsule.current) {
      capsule.current.style.display = capW > 0.5 ? "" : "none";
      capsule.current.style.width = `${capW}px`;
      capsule.current.style.transform = `translateX(${((width - capW) / 2).toFixed(2)}px) scaleY(${(1 - Math.max(-0.12, over) * 0.3).toFixed(3)})`;
    }
    if (ph === "ok" && s.doneWhenSettled && mg.m === mg.to && mg.v === 0) {
      s.doneWhenSettled = false;
      timers.current.push(window.setTimeout(() => done.current?.(), HOLD_MS));
    }
    if (caretEl.current) {
      caretEl.current.style.transform = `translateX(${(k.x - 1).toFixed(2)}px) scaleX(${(1 + Math.min(5, Math.abs(k.v) * 0.9)).toFixed(3)})`;
      caretEl.current.dataset.on = String(caretEl.current.dataset.want === "true" && m < 0.08);
    }
    if (okEl.current) {
      const t = smooth(0.72, 1, m);
      okEl.current.style.opacity = String(t);
      okEl.current.style.scale = String(mix(0.92, 1, t));
    }
    return busy;
  };

  /** Runs the loop while something moves; it stops itself after. */
  const wake = () => {
    const s = motion.current;
    if (s.raf) return;
    let prev = 0;
    const tick = (t: number) => {
      const dt = prev ? clamp((t - prev) / 16.67, 0, 2.5) : 1;
      prev = t;
      s.raf = paint(t, dt) ? requestAnimationFrame(tick) : 0;
    };
    s.raf = requestAnimationFrame(tick);
  };

  useLayoutEffect(() => {
    motion.current.live = { code, n, phase, rowW };
    paint(performance.now(), 0);
    wake();
  });

  useEffect(() => {
    const s = motion.current;
    const pending = timers.current;
    s.still = reducedMotion();
    if (autoFocus) input.current?.focus();
    return () => {
      cancelAnimationFrame(s.raf);
      s.raf = 0;
      pending.forEach(window.clearTimeout);
    };
  }, [autoFocus]);

  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  const check = (full: string) => {
    setPhase("check");
    const started = performance.now();
    const still = motion.current.still;
    void onSubmit(full)
      .catch(() => false)
      .then((ok) => {
        // A beat of checking even when the answer is instant, so the result reads as one.
        later(
          () => {
            if (ok) {
              setPhase("ok");
              motion.current.merge.to = 1;
              motion.current.doneWhenSettled = true;
              input.current?.blur();
              wake();
            } else {
              setPhase("no");
              motion.current.shookAt = performance.now();
              wake();
              later(
                () => {
                  setCode("");
                  setPhase("type");
                  input.current?.focus();
                },
                still ? 0 : SHAKE_MS + n * 45 + 160,
              );
            }
          },
          still ? 0 : Math.max(0, CHECK_MS - (performance.now() - started)),
        );
      });
  };

  const onChange = (raw: string) => {
    if (phase !== "type") return;
    const next = raw.replace(/\D/g, "").slice(0, n);
    const s = motion.current;
    // Each new digit swells its cell; a paste runs along the row.
    if (!s.still && next.length > code.length) {
      const t0 = performance.now();
      for (let i = code.length; i < next.length; i++) s.popAt[i] = t0 + (i - code.length) * 45;
    }
    setCode(next);
    onType?.();
    if (next.length === n) check(next);
  };

  return (
    <div className="code-input" data-phase={phase}>
      <div className="code-input-row" style={{ width: rowW, height: H }}>
        <div className="code-input-goo" aria-hidden="true" style={{ filter: `url(#${goo})` }}>
          {Array.from({ length: n }, (_, i) => (
            <span
              key={i}
              ref={(el) => {
                cells.current[i] = el;
              }}
              className="code-input-cell"
              style={{ width: W, borderRadius: r }}
            />
          ))}
          <span ref={capsule} className="code-input-cell" style={{ width: 0, borderRadius: H / 2, display: "none" }} />
        </div>
        {Array.from({ length: n }, (_, i) => (
          <span
            key={i}
            ref={(el) => {
              slots.current[i] = el;
            }}
            className="code-input-slot"
            data-next={phase === "type" && focus && i === code.length}
            style={{ width: W, borderRadius: r }}
            aria-hidden="true"
          >
            {code[i] ? (
              <span key={`${i}-${code[i]}`} className="code-input-digit">
                {mask ? <span className="code-input-dot" /> : code[i]}
              </span>
            ) : null}
          </span>
        ))}
        <i ref={caretEl} className="code-input-caret" data-want={phase === "type" && focus && code.length < n} />
        <span ref={okEl} className="code-input-ok" style={{ opacity: 0 }}>
          <Icon icon={Tick02Icon} size={15} />
          {okLabel}
        </span>
        <input
          ref={input}
          className="code-input-field"
          value={code}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          type={mask ? "password" : "text"}
          inputMode="numeric"
          autoComplete={mask ? "off" : "one-time-code"}
          maxLength={n}
          aria-label={label}
          aria-invalid={phase === "no"}
          readOnly={phase !== "type"}
          spellCheck={false}
        />
      </div>
      <svg className="code-input-defs" aria-hidden="true" focusable="false">
        <defs>
          <filter id={goo} x="-50%" y="-50%" width="200%" height="200%" colorInterpolationFilters="sRGB">
            <feGaussianBlur in="SourceGraphic" stdDeviation={3} result="smear" />
            <feColorMatrix in="smear" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -12" />
          </filter>
        </defs>
      </svg>
    </div>
  );
}
