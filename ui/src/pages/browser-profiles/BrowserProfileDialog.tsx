import { useId, useState, type FormEvent } from "react";
import type { Agent, BrowserProfile } from "@paperclipai/shared";
import { AgentMultiSelect } from "@/components/AgentMultiSelect";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  BROWSER_DOMAIN_HINT,
  validateBrowserProfileForm,
  type BrowserProfileFormValue,
} from "./browser-profile-helpers";

export interface BrowserProfileSubmit extends BrowserProfileFormValue {
  allowedAgentIds: string[];
}

interface BrowserProfileDialogProps {
  /** The profile being edited, or null to create a new one. */
  profile: BrowserProfile | null;
  agents: Agent[];
  agentsLoading: boolean;
  pending: boolean;
  error: string | null;
  onSubmit: (value: BrowserProfileSubmit) => void;
  onClose: () => void;
}

/** Create or edit a profile: name, allowed domains (one per line) and allowed agents. */
export function BrowserProfileDialog({
  profile,
  agents,
  agentsLoading,
  pending,
  error,
  onSubmit,
  onClose,
}: BrowserProfileDialogProps) {
  const nameId = useId();
  const domainsId = useId();
  const domainsHintId = useId();
  const agentsLabelId = useId();
  const [name, setName] = useState(profile?.name ?? "");
  const [domainText, setDomainText] = useState(
    profile?.allowedDomains.join("\n") ?? "",
  );
  const [agentIds, setAgentIds] = useState<Set<string>>(
    () => new Set(profile?.allowedAgentIds ?? []),
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const selectableAgents = agents.filter((agent) => agent.status !== "terminated");
  const shownError = validationError ?? error;
  const isEdit = profile !== null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = validateBrowserProfileForm(name, domainText);
    if (!result.ok) {
      setValidationError(result.error);
      return;
    }
    setValidationError(null);
    onSubmit({ ...result.value, allowedAgentIds: [...agentIds] });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="max-h-(--sz-calc-18) overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit browser profile" : "New browser profile"}</DialogTitle>
          <DialogDescription>
            A profile keeps one saved login that every allowed agent shares.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit} noValidate>
          <div className="space-y-1.5">
            <Label htmlFor={nameId}>Name</Label>
            <Input
              id={nameId}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Acme support login"
              autoComplete="off"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={domainsId}>Allowed domains</Label>
            <Textarea
              id={domainsId}
              value={domainText}
              onChange={(event) => setDomainText(event.target.value)}
              rows={4}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              placeholder={"app.example.com\n*.example.com"}
              aria-describedby={domainsHintId}
              className="font-mono"
            />
            <p id={domainsHintId} className="text-xs text-muted-foreground">
              One host per line. {BROWSER_DOMAIN_HINT}; a wildcard matches subdomains but
              not the bare domain. Agents can only open these hosts with this profile.
            </p>
          </div>
          <div className="space-y-1.5" role="group" aria-labelledby={agentsLabelId}>
            <p id={agentsLabelId} className="text-sm font-medium">
              Allowed agents
            </p>
            <AgentMultiSelect
              agents={selectableAgents}
              selectedAgentIds={agentIds}
              onChange={setAgentIds}
              loading={agentsLoading}
              emptyMessage="This company has no agents yet."
            />
            <p className="text-xs text-muted-foreground">
              Only these agents can use the saved login.
            </p>
          </div>
          {shownError ? (
            <p role="alert" className="text-sm text-destructive">
              {shownError}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : isEdit ? "Save changes" : "Create profile"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
