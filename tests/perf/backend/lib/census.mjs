/**
 * Row counts and growth for the per-route statement census. Node built-ins
 * only; no server needed, so the self-tests cover it.
 *
 * A census compares the statements one request of a route sends at two or more
 * data sizes. A flat count only means "no N+1" when the response had more rows
 * to build at the larger size. When it did not (the seed creates no such
 * data), the route is `unmeasured`, never "not N+1 shaped".
 */

/** Extra statements per extra unit of data, from which a route reads as N+1 shaped. */
export const N_PLUS_ONE_STATEMENTS_PER_UNIT = 0.5;

/** The rows of a list response: the array itself, or the longest array of a wrapper object (`items`, ...). */
export function listRows(json) {
  if (Array.isArray(json)) return json.length;
  if (json && typeof json === "object") {
    return Math.max(0, ...Object.values(json).filter(Array.isArray).map((list) => list.length));
  }
  return 0;
}

const sumNumbers = (value) => Object.values(value ?? {}).reduce((sum, item) => sum + (typeof item === "number" ? item : 0), 0);

/**
 * The entities the counters of the dashboard cover: every agent, and the open
 * and the done tasks (`inProgress` and `blocked` are part of `open`).
 */
export function dashboardRows(json) {
  return sumNumbers(json?.agents) + (json?.tasks?.open ?? 0) + (json?.tasks?.done ?? 0);
}

/**
 * Growth of one route between the smallest and the largest size.
 *
 * @param {{
 *   sizes: number[],
 *   statements: Record<number, number>,
 *   rows: Record<number, number>,
 *   agents: Record<number, number>,
 * }} input statements per request, rows the response returned, and agents seeded, by size
 *
 * Two units are read because the seed has fewer agents than issues: a route
 * that sends one statement per distinct agent would read as 0.1 per issue.
 * A route is N+1 shaped when it grows by 0.5 statements or more per extra
 * returned row or per extra agent.
 */
export function analyzeRoute({ sizes, statements, rows, agents }) {
  const small = sizes[0];
  const large = sizes.at(-1);
  const base = { rowsReturned: rows, statementsPerRequest: statements };
  if (sizes.length < 2 || large === small) {
    return { ...base, status: "unmeasured", reason: "fewer than two sizes", nPlusOneShaped: null };
  }
  const extraRows = rows[large] - rows[small];
  if (!(extraRows > 0)) {
    return { ...base, status: "unmeasured", reason: "the response did not return more rows at the larger size", nPlusOneShaped: null };
  }
  const extraStatements = statements[large] - statements[small];
  const extraAgents = agents[large] - agents[small];
  const perReturnedRow = extraStatements / extraRows;
  const perAgent = extraAgents > 0 ? extraStatements / extraAgents : null;
  return {
    ...base,
    status: "measured",
    perReturnedRow,
    perAgent,
    nPlusOneShaped: Math.max(perReturnedRow, perAgent ?? Number.NEGATIVE_INFINITY) >= N_PLUS_ONE_STATEMENTS_PER_UNIT,
  };
}
