import { RoutineStepsEditor } from "../RoutineStepsEditor";
import { useRoutineDetail } from "./context";

/** The steps a run creates; shared by both routine detail layouts. */
export function StepsSection() {
  const { editDraft, setEditDraft, assigneeOptions, currentAssignee, mentionOptions } = useRoutineDetail();

  return (
    <RoutineStepsEditor
      steps={editDraft.steps}
      onChange={(steps) => setEditDraft((current) => ({ ...current, steps }))}
      agentOptions={assigneeOptions.filter((option) => option.id)}
      defaultAgentName={currentAssignee?.name ?? null}
      mentionOptions={mentionOptions}
    />
  );
}
