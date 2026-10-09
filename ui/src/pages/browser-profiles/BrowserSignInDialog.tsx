import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Eye, EyeOff, Send } from "lucide-react";
import type {
  BrowserKey,
  BrowserProfile,
  BrowserSignInInput,
  BrowserSignInState,
} from "@paperclipai/shared";
import { browserProfilesApi } from "@/api/browser-profiles";
import { ApiError } from "@/api/client";
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
import { cn, formatDateTime } from "@/lib/utils";
import {
  defaultSignInUrl,
  errorMessage,
  normalizeNavigateUrl,
  scaleFrameClick,
} from "./browser-profile-helpers";

export const SIGN_IN_REFRESH_MS = 1000;
const SESSION_GONE_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 409, 410]);
const KEY_BUTTONS: readonly BrowserKey[] = ["Enter", "Tab", "Backspace", "Escape"];
const SCROLL_FRACTION = 0.6;
const MAX_SCROLL = 2000;
const MAX_TYPED_CHARS = 500;
const ADDRESS_ERROR = "Enter a web address such as https://app.example.com.";

/** Cache-busting value for the frame URL: wall-clock time, always strictly increasing. */
function nextFrameTick(previous: number): number {
  return Math.max(Date.now(), previous + 1);
}

interface BrowserSignInDialogProps {
  companyId: string;
  profile: BrowserProfile;
  /** The person closed the view. Nothing is saved and the browser stays open until it expires. */
  onClose: () => void;
  /** "End and save" succeeded; the login is stored and the lease is released. */
  onSaved: (profile: BrowserProfile) => void;
}

/**
 * Live view of the profile's real browser. The frame is an image refreshed about
 * once a second and after every input. Mounting starts nothing by itself: the
 * person starts the session, and unmounting only stops polling.
 */
export function BrowserSignInDialog({
  companyId,
  profile,
  onClose,
  onSaved,
}: BrowserSignInDialogProps) {
  const startUrlId = useId();
  const typeId = useId();
  const addressId = useId();
  const [startUrl, setStartUrl] = useState(() => defaultSignInUrl(profile));
  const [session, setSession] = useState<BrowserSignInState | null>(null);
  const [frameTick, setFrameTick] = useState(0);
  const [frameFailed, setFrameFailed] = useState(false);
  const [sessionLost, setSessionLost] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [maskText, setMaskText] = useState(false);
  const [address, setAddress] = useState("");
  const busyRef = useRef(false);
  const pollingRef = useRef(false);

  const startMutation = useMutation({
    mutationFn: (url: string | undefined) =>
      browserProfilesApi.startSignIn(companyId, profile.id, url),
    onSuccess: (state) => {
      setSession(state);
      setSessionLost(false);
      setError(null);
      setFrameTick(nextFrameTick);
    },
    onError: (cause) => setError(errorMessage(cause, "Could not start the sign-in browser.")),
  });

  const endMutation = useMutation({
    mutationFn: () => browserProfilesApi.endSignIn(companyId, profile.id),
    onSuccess: (saved) => onSaved(saved),
    onError: (cause) => setError(errorMessage(cause, "Could not save the login.")),
  });

  const live =
    session !== null && !sessionLost && !endMutation.isPending && !endMutation.isSuccess;

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => {
      setFrameTick(nextFrameTick);
      if (pollingRef.current) return;
      pollingRef.current = true;
      browserProfilesApi
        .signInState(companyId, profile.id)
        .then((next) => setSession(next))
        .catch((cause: unknown) => {
          if (cause instanceof ApiError && SESSION_GONE_STATUSES.has(cause.status)) {
            setSessionLost(true);
            setError("The sign-in session has ended. Close this window and start again.");
          }
        })
        .finally(() => {
          pollingRef.current = false;
        });
    }, SIGN_IN_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [live, companyId, profile.id]);

  const sendInput = useCallback(
    async (input: BrowserSignInInput): Promise<boolean> => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      try {
        const next = await browserProfilesApi.sendSignInInput(companyId, profile.id, input);
        setSession(next);
        setFrameTick(nextFrameTick);
        setError(null);
        return true;
      } catch (cause) {
        setError(errorMessage(cause, "The browser did not accept that input."));
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [companyId, profile.id],
  );

  const sessionClosed = sessionLost || endMutation.isPending;
  const controlsDisabled = busy || sessionClosed;

  function handleStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = startUrl.trim();
    if (trimmed === "") {
      startMutation.mutate(undefined);
      return;
    }
    const normalized = normalizeNavigateUrl(trimmed);
    if (!normalized) {
      setError(ADDRESS_ERROR);
      return;
    }
    setError(null);
    startMutation.mutate(normalized);
  }

  function handleFrameClick(event: MouseEvent<HTMLImageElement>) {
    if (!session || controlsDisabled) return;
    const point = scaleFrameClick(event, event.currentTarget.getBoundingClientRect(), session);
    if (point) void sendInput({ type: "click", x: point.x, y: point.y });
  }

  async function handleSendText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (text.length === 0) return;
    const sent = await sendInput({ type: "type", text });
    if (sent) setText("");
  }

  async function handleGo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = normalizeNavigateUrl(address);
    if (!url) {
      setError(ADDRESS_ERROR);
      return;
    }
    const sent = await sendInput({ type: "navigate", url });
    if (sent) setAddress("");
  }

  function scroll(direction: 1 | -1) {
    if (!session) return;
    const step = Math.min(Math.round(session.height * SCROLL_FRACTION), MAX_SCROLL);
    void sendInput({ type: "scroll", deltaY: direction * step });
  }

  const errorNote = error ? (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  ) : null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="max-h-(--sz-calc-18) overflow-y-auto p-4 sm:max-w-3xl sm:p-6"
        onInteractOutside={(event) => {
          if (session) event.preventDefault();
        }}
      >
        {session === null ? (
          <>
            <DialogHeader>
              <DialogTitle>Sign in to {profile.name}</DialogTitle>
              <DialogDescription>
                Opens a live browser. Sign in as you normally would, then choose End and save.
                The saved login is shared with every agent this profile allows.
              </DialogDescription>
            </DialogHeader>
            <form className="space-y-4" onSubmit={handleStart} noValidate>
              <div className="space-y-1.5">
                <Label htmlFor={startUrlId}>Start address (optional)</Label>
                <Input
                  id={startUrlId}
                  value={startUrl}
                  onChange={(event) => setStartUrl(event.target.value)}
                  inputMode="url"
                  autoCapitalize="off"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://app.example.com"
                  className="font-mono"
                />
              </div>
              {errorNote}
              <div className="flex items-center justify-between gap-2">
                <Button type="button" variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit" disabled={startMutation.isPending}>
                  {startMutation.isPending ? "Starting…" : "Start sign-in"}
                </Button>
              </div>
            </form>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Signing in to {profile.name}</DialogTitle>
              <DialogDescription>
                Click the page to interact with it. Nothing is saved until you choose End and
                save.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-0.5 text-xs">
              <p className="truncate text-sm font-medium" title={session.title}>
                {session.title || "Untitled page"}
              </p>
              <p className="truncate font-mono text-muted-foreground" title={session.url}>
                {session.url}
              </p>
              <p className="text-muted-foreground">
                Session expires{" "}
                <time dateTime={session.expiresAt} className="font-mono">
                  {formatDateTime(session.expiresAt, { includeYear: false })}
                </time>
              </p>
            </div>
            <div className="overflow-hidden rounded-md border border-border bg-muted">
              <img
                src={browserProfilesApi.signInFrameUrl(companyId, profile.id, frameTick)}
                alt={`Live view of ${session.title || session.url}`}
                width={session.width}
                height={session.height}
                draggable={false}
                onClick={handleFrameClick}
                onLoad={() => setFrameFailed(false)}
                onError={() => setFrameFailed(true)}
                className={cn(
                  "block h-auto w-full select-none",
                  controlsDisabled ? "cursor-wait" : "cursor-pointer",
                )}
              />
            </div>
            {frameFailed ? (
              <p className="text-xs text-muted-foreground">
                The live view is not updating. It will keep retrying.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2" role="group" aria-label="Browser keys and scrolling">
              {KEY_BUTTONS.map((key) => (
                <Button
                  key={key}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={controlsDisabled}
                  onClick={() => void sendInput({ type: "key", key })}
                >
                  {key}
                </Button>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={controlsDisabled}
                onClick={() => scroll(-1)}
              >
                <ArrowUp aria-hidden="true" />
                Scroll up
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={controlsDisabled}
                onClick={() => scroll(1)}
              >
                <ArrowDown aria-hidden="true" />
                Scroll down
              </Button>
            </div>
            <form className="space-y-1.5" onSubmit={handleSendText}>
              <Label htmlFor={typeId}>Type into the selected field</Label>
              <div className="flex items-center gap-2">
                <Input
                  id={typeId}
                  type={maskText ? "password" : "text"}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  maxLength={MAX_TYPED_CHARS}
                  autoCapitalize="off"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={sessionClosed}
                  className="min-w-0 flex-1"
                />
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={maskText ? "Show typed text" : "Hide typed text"}
                  aria-pressed={maskText}
                  onClick={() => setMaskText((current) => !current)}
                >
                  {maskText ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                </Button>
                <Button type="submit" size="sm" disabled={controlsDisabled || text.length === 0}>
                  <Send aria-hidden="true" />
                  Send
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Click a field on the page first. Typed text is sent as-is and is not stored here.
              </p>
            </form>
            <form className="space-y-1.5" onSubmit={handleGo}>
              <Label htmlFor={addressId}>Go to address</Label>
              <div className="flex items-center gap-2">
                <Input
                  id={addressId}
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  inputMode="url"
                  autoCapitalize="off"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://app.example.com/login"
                  disabled={sessionClosed}
                  className="min-w-0 flex-1 font-mono"
                />
                <Button type="submit" size="sm" variant="outline" disabled={controlsDisabled}>
                  Go
                </Button>
              </div>
            </form>
            {errorNote}
            <p className="text-xs text-muted-foreground">
              Close leaves the browser open until it expires and saves nothing.
            </p>
            <div className="flex items-center justify-between gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Close
              </Button>
              <Button
                type="button"
                onClick={() => endMutation.mutate()}
                disabled={endMutation.isPending}
              >
                {endMutation.isPending ? "Saving…" : "End and save"}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
