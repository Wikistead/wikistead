import { Select as Ark, createListCollection } from "@ark-ui/react/select";
import { Portal } from "@ark-ui/react/portal";
import { Check, ChevronsUpDown } from "lucide-react";
import styles from "./Select.module.css";

export interface SelectOption { value: string; label: string }

// DS select (Phase 5) — Ark UI Select replacing raw <select>, so selection matches
// the rest of the design system (the 3b DS missed it). Drop-in for the common
// single-value pattern; keeps a stable trigger testid plus per-option testids
// (`${testId}-${value}`) so tests click the trigger then the option.
export function Select({
  value, onChange, options, ariaLabel, disabled, testId, size = "md",
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  ariaLabel?: string;
  disabled?: boolean;
  testId?: string;
  size?: "sm" | "md";
}) {
  const collection = createListCollection({ items: options });
  return (
    <Ark.Root
      collection={collection}
      value={[value]}
      onValueChange={(d) => { if (d.value[0] != null) onChange(d.value[0]); }}
      disabled={disabled}
      positioning={{ sameWidth: true }}
    >
      <Ark.Control>
        <Ark.Trigger className={`${styles.trigger} ${size === "sm" ? styles.sm : ""}`} aria-label={ariaLabel} data-testid={testId}>
          <Ark.ValueText />
          <ChevronsUpDown size={14} className={styles.caret} />
        </Ark.Trigger>
      </Ark.Control>
      <Portal>
        <Ark.Positioner>
          <Ark.Content className={styles.content}>
            {options.map((o) => (
              <Ark.Item key={o.value} item={o} className={styles.item} data-testid={testId ? `${testId}-${o.value}` : undefined}>
                <Ark.ItemText>{o.label}</Ark.ItemText>
                <Ark.ItemIndicator className={styles.indicator}><Check size={14} /></Ark.ItemIndicator>
              </Ark.Item>
            ))}
          </Ark.Content>
        </Ark.Positioner>
      </Portal>
    </Ark.Root>
  );
}
