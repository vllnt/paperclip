export function grokLocalReasoningEffortsForModel(model: string): readonly string[] {
  return model.trim() === "grok-4.7" || model.trim() === "grok-4.6"
    ? ["low", "medium", "high", "xhigh"]
    : ["low", "medium", "high"];
}
