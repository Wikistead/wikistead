import { Menu } from "@ark-ui/react/menu";
import { Portal } from "@ark-ui/react/portal";
import { MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import styles from "./OverflowMenu.module.css";

// A ••• overflow menu (Ark Menu) for secondary page actions — the IA pattern of
// keeping the top bar minimal and folding occasional actions away (Phase 3b-3).
export interface OverflowItem {
  value: string;
  label: string;
  icon?: ReactNode;
  testId?: string;
  danger?: boolean;
}

export function OverflowMenu({
  items,
  onSelect,
  label = "More actions",
  testId = "page-overflow",
}: {
  items: OverflowItem[];
  onSelect: (value: string) => void;
  label?: string;
  testId?: string;
}) {
  return (
    <Menu.Root onSelect={(d) => onSelect(d.value)}>
      <Menu.Trigger className={styles.trigger} aria-label={label} title={label} data-testid={`${testId}-trigger`}>
        <MoreHorizontal size={16} />
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content className={styles.content} data-testid={testId}>
            {items.map((it) => (
              <Menu.Item key={it.value} value={it.value} className={styles.item} data-testid={it.testId} data-danger={it.danger ? "" : undefined}>
                {it.icon}
                {it.label}
              </Menu.Item>
            ))}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}
