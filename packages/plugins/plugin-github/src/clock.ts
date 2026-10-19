/** A difference between GitHub's clock and this host's larger than this is reported. */
export const CLOCK_SKEW_ALERT_MS = 60_000;
/** GitHub's `Date` header has one-second resolution: a smaller difference is measurement noise. */
const NOISE_MS = 2_000;
/** A slower answer (or a process stalled meanwhile) dates GitHub's clock too loosely to learn from. */
const MAX_ROUND_TRIP_MS = 10_000;
/** Beyond a year the header is not a clock. */
const MAX_SKEW_MS = 366 * 24 * 3_600_000;

/**
 * GitHub's clock as seen from this host, learned from the `Date` header of
 * every GitHub response (errors included). Token expiry is GitHub's decision,
 * made by GitHub's clock: a host clock that is hours off (a VM paused and
 * resumed) would otherwise hand out tokens GitHub already expired, or sign App
 * JWTs GitHub refuses.
 */
export class GitHubClock {
  private offset = 0;
  /** Called when the skew crosses {@link CLOCK_SKEW_ALERT_MS}, in either direction. */
  onSkewChange: (skewMs: number) => void = () => {};

  constructor(private local: () => number = () => Date.now(), private monotonic: () => number = () => performance.now()) {}

  /** This host's clock corrected to GitHub's. */
  now(): number { return this.local() + this.offset; }

  /** GitHub's clock minus this host's: positive when this host is behind. */
  skewMs(): number { return this.offset; }

  /** Marks a request's start for {@link observe}; monotonic, so a clock step during the request does not skew the sample. */
  started(): number { return this.monotonic(); }

  /** Records the `Date` header of the answer to a request that {@link started} at `startedAt`. */
  observe(date: string | null | undefined, startedAt: number): void {
    const server = date ? Date.parse(date) : NaN;
    const roundTrip = this.monotonic() - startedAt;
    if (!Number.isFinite(server) || !(roundTrip >= 0 && roundTrip <= MAX_ROUND_TRIP_MS)) return;
    // The header is truncated to the second (GitHub's time was half a second later on average), taken mid-round-trip.
    const sample = server + 500 - (this.local() - roundTrip / 2);
    if (Math.abs(sample) > MAX_SKEW_MS) return;
    const next = Math.abs(sample) < NOISE_MS ? 0 : Math.round(sample);
    const skewed = (value: number) => Math.abs(value) > CLOCK_SKEW_ALERT_MS;
    const changed = skewed(next) !== skewed(this.offset);
    this.offset = next;
    if (changed) {
      try { this.onSkewChange(next); } catch { /* A failing listener never fails the request. */ }
    }
  }
}
