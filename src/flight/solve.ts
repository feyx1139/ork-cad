// Finds the setting (a nose weight, a cant angle) that gives a target apogee, when each try is a
// whole flight simulation: as few tries as it can, and never a setting outside the allowed range.

export interface Solution {
  /** The setting found, and the apogee it gives. */
  x: number;
  y: number;
  /** Every try, in order. */
  tries: { x: number; y: number }[];
  /** False if the target is outside what the range can reach; x is then the nearest end. */
  reached: boolean;
}

/**
 * The x in [lo, hi] where f(x) = target, to within `tolerance`. f is expected to change steadily
 * with x (more nose weight, lower apogee). Starts from x0 and x0 + step and takes secant steps,
 * falling back to halving the interval once the target is bracketed, should a step go astray.
 */
export async function solve(
  f: (x: number) => Promise<number>,
  target: number,
  { x0, step, lo, hi, tolerance, maxTries = 30 }: { x0: number; step: number; lo: number; hi: number; tolerance: number; maxTries?: number },
): Promise<Solution> {
  const tries: { x: number; y: number }[] = [];
  const at = async (x: number) => {
    const y = await f(x);
    tries.push({ x, y });
    return y;
  };
  const clamp = (x: number) => Math.min(hi, Math.max(lo, x));
  let a = clamp(x0);
  let fa = (await at(a)) - target;
  if (Math.abs(fa) <= tolerance) return { x: a, y: fa + target, tries, reached: true };
  let b = clamp(a + step);
  if (b === a) b = clamp(a - step);
  let fb = (await at(b)) - target;
  /** Points on either side of the target, once known. */
  let bracket: [number, number, number, number] | undefined;
  const note = (x: number, fx: number) => {
    for (const p of tries) {
      const fp = p.y - target;
      if (Math.sign(fp) !== Math.sign(fx) && fp !== 0) {
        if (!bracket || Math.abs(p.x - x) < Math.abs(bracket[0] - bracket[2])) bracket = [x, fx, p.x, fp];
      }
    }
  };
  note(a, fa);
  note(b, fb);
  while (tries.length < maxTries) {
    if (Math.abs(fb) <= tolerance) return { x: b, y: fb + target, tries, reached: true };
    let next = fb === fa ? NaN : b - (fb * (b - a)) / (fb - fa);
    if (bracket) {
      const [x1, , x2] = bracket;
      // A secant step must stay inside the bracket, or else halve it.
      if (!(next > Math.min(x1, x2) && next < Math.max(x1, x2))) next = (x1 + x2) / 2;
    } else if (!Number.isFinite(next)) {
      next = b + (b - a);
    }
    next = clamp(next);
    if (next === b) {
      // Stuck at an end of the range without reaching the target.
      return { x: b, y: fb + target, tries, reached: false };
    }
    [a, fa] = [b, fb];
    b = next;
    fb = (await at(b)) - target;
    note(b, fb);
    if (bracket) {
      // Keep the bracket tight: the newest point and the nearest on the other side.
      const [x1, f1, x2, f2] = bracket;
      if (Math.sign(fb) === Math.sign(f1)) bracket = [b, fb, x2, f2];
      else if (Math.sign(fb) === Math.sign(f2)) bracket = [x1, f1, b, fb];
    }
  }
  const best = tries.reduce((p, q) => (Math.abs(q.y - target) < Math.abs(p.y - target) ? q : p));
  return { x: best.x, y: best.y, tries, reached: Math.abs(best.y - target) <= tolerance };
}
