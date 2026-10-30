/** Bump when question wording changes so cached answers are not reused across rubrics. */
export const TRIAGE_RUBRIC_VERSION = "issue-triage-1";

/** Hard bound on model calls for one issue, whatever the number of candidate agents. */
export const TRIAGE_MAX_MODEL_CALLS = 6;
/** Owner options per model call (the "no fit" option is extra). */
export const TRIAGE_OWNER_PAGE_SIZE = 10;
/** Titles with fewer words than this are never sent: "Fix bug" is shared by unrelated work. */
export const TRIAGE_MIN_TITLE_WORDS = 3;

/** The top owner needs at least this probability to be applied. */
export const TRIAGE_OWNER_MIN_PROBABILITY = 0.8;
/** The top owner must beat the next option by at least this much to be applied. */
export const TRIAGE_OWNER_MIN_MARGIN = 0.2;
/** Guards the margin test against floating-point noise (0.9 - 0.7 is 0.20000000000000007). */
export const TRIAGE_PROBABILITY_EPSILON = 1e-9;

/** The owner option that means no listed role fits. */
export const TRIAGE_NO_OWNER_KEY = "none";

/** Priority that new issues get when the creator names none. It cannot be told from an explicit choice. */
export const TRIAGE_DEFAULT_PRIORITY = "medium";
