import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SquareTerminal, Eye, Code, Check, X } from "lucide-react"; // #493: WYSIWYG glyph is Eye now
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Button } from "../ui/Button";
import { useSession } from "../session/SessionProvider";
import { useAccountSettings, useUpdateAccountSettings, type EditorChromeVisibility } from "../data/queries";

// #289 / ADR-115: the first-run editor persona enrollment — two questions route the member to a
// preset (vim / markdown / wysiwyg) that writes ONLY display preferences: the editorChrome
// visibility object + the editor_display_mode startup column (and, for the vim persona, the
// keymap default = ON). Data-inert: never touches page content. Skip keeps the FULL chrome and
// only marks the flow seen (ruling #4).

type Persona = "vim" | "markdown" | "wysiwyg";

const CHROME: Record<Persona, EditorChromeVisibility> = {
  vim: { vimToggleVisible: true, modesVisible: { live: true, source: true, reading: true, wysiwyg: false } },
  markdown: { vimToggleVisible: false, modesVisible: { live: true, source: true, reading: true, wysiwyg: false } },
  wysiwyg: { vimToggleVisible: false, modesVisible: { live: false, source: false, reading: true, wysiwyg: true } },
};
// #347 the SKIP ("answer later") default is its OWN balanced preset, not the markdown persona. The
// "didn't answer" member is better served by WYSIWYG than raw Source (a power-user mode they can add from
// settings), so skip shows Live / Reading / WYSIWYG (Source hidden), vim off, launch Live. The explicit
// "markdown" persona is unchanged (it keeps Source for the raw-markdown crowd).
const SKIP_CHROME: EditorChromeVisibility = { vimToggleVisible: false, modesVisible: { live: true, source: false, reading: true, wysiwyg: true } };
const SKIP_CHANGE_KEYS = ["onboarding.changedHidVim", "onboarding.changedStartLive", "onboarding.changedBalancedModes"];
// What each preset changes — the completion screen lists these lines (ADR-115 §1/§6).
const CHANGE_KEYS: Record<Persona, string[]> = {
  vim: ["onboarding.changedVimOn", "onboarding.changedStartLive", "onboarding.changedHidWysiwyg"],
  markdown: ["onboarding.changedHidVim", "onboarding.changedStartLive", "onboarding.changedHidWysiwyg"],
  wysiwyg: ["onboarding.changedHidVim", "onboarding.changedStartWysiwyg", "onboarding.changedHidMarkdownModes"],
};

// The controlled two-question flow — reused by the first-run gate below AND the settings
// "redo the questions" entry (§5).
export function EditorOnboardingDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const update = useUpdateAccountSettings();
  const [step, setStep] = useState<"q1" | "q2" | "done">("q1");
  const [persona, setPersona] = useState<Persona | null>(null);
  const [skipped, setSkipped] = useState(false); // #347: the done screen shows a distinct note when reached by skip

  const reset = () => { setStep("q1"); setPersona(null); setSkipped(false); };
  const close = () => { reset(); onClose(); };

  const apply = (p: Persona) => {
    setPersona(p);
    update.mutate({
      editorChrome: CHROME[p],
      editorDisplayMode: p === "wysiwyg" ? "wysiwyg" : "live",
      // The vim persona turns vim ON (the preset table: "shown, ON"); the others leave the
      // keymap alone (vim state follows the ADR-020 keymap setting either way).
      ...(p === "vim" ? { editorKeymap: "vim" as const } : {}),
      onboardingCompleted: true,
    });
    setStep("done");
  };
  const skip = () => {
    // #347 / ADR-115 addendum (revision): skipping ("answer later") applies a BALANCED preset — the most
    // common "didn't answer" profile wants WYSIWYG, not raw Source (vim off, launch Live, Source hidden). This is
    // an EXPLICIT write scoped to this member (NOT a change to the chrome=null default, which would silently strip
    // vim from backfilled members). Vim stays reachable via Ctrl+Alt+V (no dead-end); the done screen shows a note.
    setPersona(null);
    setSkipped(true);
    update.mutate({ editorChrome: SKIP_CHROME, editorDisplayMode: "live", onboardingCompleted: true });
    setStep("done");
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { if (step !== "done") update.mutate({ onboardingCompleted: true }); close(); } }}>
      <DialogContent data-testid="onboarding-dialog" className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{t(step === "done" ? "onboarding.doneTitle" : "onboarding.title")}</DialogTitle>
        </DialogHeader>
        {step === "q1" && (
          <div className="flex flex-col gap-3" data-testid="onboarding-q1">
            <p className="font-medium">{t("onboarding.q1")}</p>
            <p className="text-xs text-fg-dim">{t("onboarding.unsureNo")}</p>
            <div className="flex gap-2">
              <Button variant="primary" data-testid="onboarding-q1-yes" onClick={() => apply("vim")}><SquareTerminal size={14} /> {t("common.yes")}</Button>
              <Button data-testid="onboarding-q1-no" onClick={() => setStep("q2")}>{t("common.no")}</Button>
            </div>
            <button type="button" className="self-start text-xs text-fg-dim underline hover:text-foreground" data-testid="onboarding-skip" onClick={skip}>
              {t("onboarding.later")}
            </button>
          </div>
        )}
        {step === "q2" && (
          <div className="flex flex-col gap-3" data-testid="onboarding-q2">
            <p className="font-medium">{t("onboarding.q2")}</p>
            <p className="text-xs text-fg-dim">{t("onboarding.unsureNo")}</p>
            <div className="flex gap-2">
              <Button variant="primary" data-testid="onboarding-q2-yes" onClick={() => apply("markdown")}><Code size={14} /> {t("common.yes")}</Button>
              <Button data-testid="onboarding-q2-no" onClick={() => apply("wysiwyg")}><Eye size={14} /> {t("common.no")}</Button>
            </div>
            <button type="button" className="self-start text-xs text-fg-dim underline hover:text-foreground" data-testid="onboarding-skip" onClick={skip}>
              {t("onboarding.later")}
            </button>
          </div>
        )}
        {step === "done" && (persona || skipped) && (
          <div className="flex flex-col gap-3" data-testid="onboarding-done">
            <p>{skipped ? t("onboarding.skippedNote") : t("onboarding.doneBody")}</p>
            <ul className="flex flex-col gap-1">
              {(skipped ? SKIP_CHANGE_KEYS : CHANGE_KEYS[persona!]).map((k) => (
                <li key={k} className="flex items-center gap-2 text-sm"><Check size={14} className="flex-none text-[var(--accent)]" /> {t(k)}</li>
              ))}
            </ul>
            {/* #395 / ADR-156: the one help-surface line for the atom/typed-body cursor policy. */}
            <p className="text-xs text-fg-dim">{t("onboarding.atomHint")}</p>
            <p className="text-xs text-fg-dim">{t("onboarding.doneHint")}</p>
            <div className="flex justify-end">
              <Button variant="primary" data-testid="onboarding-close" onClick={close}>{t("common.close")}</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const BANNER_LS = "wks.onboardingBannerDismissed";

// The self-gating first-run mount + the existing-user banner (ruling #2). The guarantee that
// guests never see this is the DATA dependency (ADR-115 §4): it acts only on the member's
// account-settings row (useAccountSettings is enabled only for an authed member session; a guest
// has no member row), never on a shared shell mount.
export function FirstRunOnboarding() {
  const { t } = useTranslation();
  const { status } = useSession();
  const settings = useAccountSettings();
  // LATCH: once the first-run gate fires (marker null) the dialog stays open until the user closes
  // it — applying a preset marks the flow completed mid-dialog (the settings refetch flips the gate),
  // and without the latch the dialog would vanish before the "here's what changed" screen.
  const [active, setActive] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(() => {
    try { return localStorage.getItem(BANNER_LS) === "1"; } catch { return true; }
  });
  const [redoOpen, setRedoOpen] = useState(false);
  const completedAt = settings.data?.onboardingCompletedAt;
  useEffect(() => {
    if (status === "authed" && settings.data && completedAt === null) setActive(true);
  }, [status, settings.data, completedAt]);

  if (status !== "authed" || !settings.data) return null;
  const firstRun = active;

  // Existing members (backfilled completed) who never picked a chrome: a small dismissible
  // banner announcing the setup, opening the same flow.
  const showBanner = !firstRun && !redoOpen && !bannerDismissed && settings.data.editorChrome === null && settings.data.onboardingCompletedAt !== null;
  const dismissBanner = () => {
    setBannerDismissed(true);
    try { localStorage.setItem(BANNER_LS, "1"); } catch { /* no storage */ }
  };

  return (
    <>
      <EditorOnboardingDialog open={firstRun || redoOpen} onClose={() => { setActive(false); setRedoOpen(false); }} />
      {showBanner && (
        // #339: sit ABOVE the edit-mode bottom toolbar (PageControls is `absolute bottom-4`: vim / display-mode
        // segment on one side, Publish/Close on the other). A centered banner at bottom-4 overlapped the
        // display-mode group (its left edge covered the WYSIWYG button and hijacked the click) — and the overlap
        // shifted with viewport width. `bottom-20` clears the whole bottom-4 control band, width-independently.
        // #406 S3: cap the pill to the viewport (2rem gutter) so a long banner line never overflows a phone.
        <div className="fixed bottom-20 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-popover px-4 py-2 text-sm shadow-lg" data-testid="onboarding-banner">
          <span>{t("onboarding.bannerText")}</span>
          <Button size="sm" variant="primary" data-testid="onboarding-banner-open" onClick={() => { dismissBanner(); setRedoOpen(true); }}>{t("onboarding.bannerCta")}</Button>
          <button type="button" className="flex-none rounded p-1 text-fg-dim hover:text-foreground" aria-label={t("common.close")} data-testid="onboarding-banner-dismiss" onClick={dismissBanner}>
            <X size={14} />
          </button>
        </div>
      )}
    </>
  );
}
