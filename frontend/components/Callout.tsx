import type { ReactNode } from "react";

/**
 * Highlighted callout box (Jupiter-style "TIP" panel): a small coloured badge
 * plus body text in a tinted rounded box. Reusable anywhere something needs to
 * stand out — tips, notes, actionable hints, warnings.
 *
 *   <Callout>Use a wallet with a staking key.</Callout>
 *   <Callout label="NOTE" tone="info">…</Callout>
 *   <Callout label="HEADS UP" tone="warn">…</Callout>
 */
export function Callout({
  label = "TIP",
  tone = "accent",
  children,
}: {
  label?: string;
  tone?: "accent" | "info" | "warn";
  children: ReactNode;
}) {
  return (
    <div className={`callout callout-${tone}`}>
      <span className="callout-badge">{label}</span>
      <div className="callout-body">{children}</div>
    </div>
  );
}
