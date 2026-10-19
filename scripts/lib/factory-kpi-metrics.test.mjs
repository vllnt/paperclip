import assert from "node:assert/strict";
import test from "node:test";
import {
  DAY_MS,
  HOUR_MS,
  buildThroughput,
  countBetween,
  median,
  percentile,
  prShape,
  rollingMinPerHour,
  sustainedDays,
  windowRates,
} from "./factory-kpi-metrics.mjs";

const END = Date.parse("2026-10-18T12:00:00Z");

// `perHour` merges spread evenly inside every hour of (from, to].
function steady(from, to, perHour) {
  const times = [];
  for (let t = from; t < to; t += HOUR_MS) {
    for (let i = 1; i <= perHour; i += 1) times.push(t + Math.floor((i * HOUR_MS) / (perHour + 1)));
  }
  return times.sort((a, b) => a - b);
}

test("countBetween is half-open: start excluded, end included", () => {
  const sorted = [10, 20, 30];
  assert.equal(countBetween(sorted, 10, 30), 2);
  assert.equal(countBetween(sorted, 9, 30), 3);
  assert.equal(countBetween(sorted, 30, 40), 0);
});

test("median and percentile on empty, odd and even input", () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(percentile([], 90), null);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3], 50), 2, "nearest rank rounds up");
});

test("windowRates places a merge exactly one hour old outside the 1 h window", () => {
  const sorted = [END - HOUR_MS, END - HOUR_MS + 1, END];
  const [h1, h6, h24] = windowRates(sorted, END);
  assert.deepEqual([h1.merged, h6.merged, h24.merged], [2, 3, 3]);
  assert.equal(h6.perHour, 0.5);
});

test("rollingMinPerHour reads the quietest 6 h window, not the average", () => {
  // 8/h all day except a fully quiet 6 h block in the middle.
  const busy = [...steady(END - DAY_MS, END - 15 * HOUR_MS, 8), ...steady(END - 9 * HOUR_MS, END, 8)];
  const r = rollingMinPerHour(busy, END, DAY_MS);
  assert.equal(r.minPerHour, 0);
  assert.ok(r.worstEndMs > END - 15 * HOUR_MS && r.worstEndMs < END - 9 * HOUR_MS + 6 * HOUR_MS);
  assert.ok(countBetween(busy, END - DAY_MS, END) / 24 > 4, "the 24 h average alone would hide the gap");
});

test("rollingMinPerHour only uses windows fully inside the span", () => {
  const r = rollingMinPerHour(steady(END - DAY_MS, END, 6), END, DAY_MS);
  assert.ok(Math.abs(r.minPerHour - 6) <= 1 / 6, "evenly spread 6/h keeps every 6 h window at 36 +- 1");
  assert.equal(rollingMinPerHour([], END, 5 * HOUR_MS).minPerHour, null, "a span shorter than 6 h holds no complete window");
  assert.equal(rollingMinPerHour([], END, 6 * HOUR_MS).minPerHour, 0);
  assert.equal(rollingMinPerHour([END - 1], END, 6 * HOUR_MS).minPerHour, 1 / 6, "the single window is (end - 6 h, end]");
  assert.equal(rollingMinPerHour([END - 6 * HOUR_MS], END, 6 * HOUR_MS).minPerHour, 0, "a merge exactly 6 h old is outside it");
});

test("rollingMinPerHour is exact: a dip shorter than any sampling step is still seen", () => {
  // A merge leaves the window 3 minutes before the end and the next one arrives 1 minute before it.
  // Sampling every 10 minutes from the end sees one merge in both windows; the true minimum is zero.
  const minute = 60_000;
  const times = [END - 6 * HOUR_MS - 3 * minute, END - minute];
  const r = rollingMinPerHour(times, END, 6 * HOUR_MS + 10 * minute);
  assert.equal(r.minPerHour, 0);
  assert.equal(r.worstEndMs, END - 3 * minute);
});

test("rollingMinPerHour agrees with a brute-force scan at one-minute resolution", () => {
  const minute = 60_000;
  let seed = 7;
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const times = Array.from({ length: 70 }, () => END - Math.floor(rand() * 20 * HOUR_MS)).sort((a, b) => a - b);
  const exact = rollingMinPerHour(times, END, DAY_MS).minPerHour;
  let scan = Infinity;
  for (let t = END - DAY_MS + 6 * HOUR_MS; t <= END; t += minute) scan = Math.min(scan, countBetween(times, t - 6 * HOUR_MS, t) / 6);
  assert.ok(exact <= scan, "the exact minimum is never above any sampled one");
  assert.ok(scan - exact <= 1 / 6, "and a one-minute scan is within one merge of it");
});

test("sustainedDays counts consecutive days from now and stops at the first miss", () => {
  const sorted = [...steady(END - 3 * DAY_MS, END - DAY_MS, 3), ...steady(END - DAY_MS, END, 8)];
  const s = sustainedDays(sorted, END, { targetPerHour: 6, days: 3, complete: true });
  assert.equal(s.consecutive, 1);
  assert.equal(s.done, false);
  assert.equal(s.perDay[0].meetsTarget, true);
  assert.equal(s.perDay[1].meetsTarget, false);
});

test("a day that exactly meets the target counts as meeting it", () => {
  // One merge every 10 minutes is exactly 6/h: every aligned 6 h window holds exactly 36.
  const times = [];
  for (let t = END - DAY_MS + 10 * 60 * 1000; t <= END; t += 10 * 60 * 1000) times.push(t);
  const s = sustainedDays(times, END, { targetPerHour: 6, days: 1, complete: true });
  assert.equal(s.perDay[0].rolling6hMinPerHour, 6);
  assert.equal(s.done, true);
});

test("a gap that straddles a day boundary counts against the days it touches", () => {
  // 12 per hour for 72 h, except nothing in (end - 27 h, end - 21 h]: each day alone still has a 6 h
  // window that is busy enough, but the 6 h window across the boundary is empty.
  const quiet = [...steady(END - 3 * DAY_MS, END - 27 * HOUR_MS, 12), ...steady(END - 21 * HOUR_MS, END, 12)];
  const s = sustainedDays(quiet, END, { targetPerHour: 6, days: 3, complete: true });
  assert.equal(s.perDay[1].rolling6hMinPerHour >= 6, true, "inside day -1 alone the quietest window is full");
  assert.equal(s.perDay[1].meetsTarget, false);
  assert.equal(s.consecutive, 1);
  assert.equal(s.done, false);
});

test("an old qualifying day does not count when the newest day misses", () => {
  const sorted = [...steady(END - 3 * DAY_MS, END - DAY_MS, 8), ...steady(END - DAY_MS, END, 1)];
  const s = sustainedDays(sorted, END, { targetPerHour: 6, days: 3, complete: true });
  assert.deepEqual(s.perDay.map((d) => d.meetsTarget), [false, false, false], "older days are judged together with the newer ones");
  assert.deepEqual(s.perDay.map((d) => d.rolling6hMinPerHour >= 6), [false, true, true], "each day alone is still reported");
  assert.equal(s.consecutive, 0);
  assert.equal(s.done, false);
});

test("sustainedDays reaches done after three qualifying days", () => {
  const s = sustainedDays(steady(END - 3 * DAY_MS, END, 8), END, { targetPerHour: 6, days: 3, complete: true });
  assert.equal(s.consecutive, 3);
  assert.equal(s.done, true);
});

test("sustainedDays reports unknown, not false, when the data is incomplete and the target is not met", () => {
  const sorted = steady(END - DAY_MS, END, 2);
  assert.equal(sustainedDays(sorted, END, { targetPerHour: 6, days: 3, complete: false }).done, null);
  assert.equal(sustainedDays(steady(END - 3 * DAY_MS, END, 8), END, { targetPerHour: 6, days: 3, complete: false }).done, true);
});

test("prShape summarises the last 24 h only", () => {
  const pr = (lines, ageH, openH) => ({
    lines,
    mergedAtMs: END - ageH * HOUR_MS,
    createdAtMs: END - (ageH + openH) * HOUR_MS,
  });
  const shape = prShape([pr(4, 1, 2), pr(100, 2, 4), pr(300, 3, 6), pr(9000, 30, 1)], END);
  assert.equal(shape.sample, 3);
  assert.equal(prShape([pr(10, 1, 1)], END).tinyShare, 1, "10 lines still counts as tiny");
  assert.equal(prShape([pr(11, 1, 1)], END).tinyShare, 0);
  assert.equal(shape.medianLines, 100);
  assert.equal(shape.medianOpenToMergeHours, 4);
  assert.ok(Math.abs(shape.tinyShare - 1 / 3) < 1e-9);
});

test("buildThroughput splits per repo and totals across repos", () => {
  const prs = [
    ...steady(END - DAY_MS, END, 1).map((t) => ({ repo: "o/a", mergedAtMs: t, createdAtMs: t - HOUR_MS, lines: 20 })),
    ...steady(END - DAY_MS, END, 2).map((t) => ({ repo: "o/b", mergedAtMs: t, createdAtMs: t - HOUR_MS, lines: 20 })),
  ];
  const t = buildThroughput({ prs, repos: ["o/a", "o/b"], endMs: END, targetPerHour: 6, days: 1, complete: true });
  assert.equal(t.rates[2].merged, 72);
  assert.deepEqual(t.byRepo.map((r) => r.rates[2].merged), [24, 48]);
  assert.equal(t.sustained.done, false);
});
