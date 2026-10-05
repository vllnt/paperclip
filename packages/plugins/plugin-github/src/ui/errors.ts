export function message(error: unknown): string {
  return error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message : "GitHub sync failed. Try again.";
}
