import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
// Adapted: this project uses its own ThemeProvider (data-theme), not next-themes.
import { useTheme } from "../../app/ThemeProvider"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      // Bottom-center so toasts don't sit under the bottom-right floating action buttons
      // (where they blocked the Edit/Publish group). A close button lets them be dismissed
      // regardless. richColors tints each toast + icon by type (success green / error red /
      // warning amber / info blue) so the kind reads at a glance.
      position="bottom-center"
      closeButton
      richColors
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          // This project's tokens are --panel / --fg / --border (NOT shadcn's bare
          // --popover*, which are undefined here → that made the toast transparent).
          "--normal-bg": "var(--panel)",
          "--normal-text": "var(--fg)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
