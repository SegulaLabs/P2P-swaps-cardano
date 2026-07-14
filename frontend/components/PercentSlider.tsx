"use client";

/**
 * Jupiter-style amount slider: a lime-filled range plus 25/50/75/MAX quick
 * chips. `value` is the current percent (0–100, derived from the typed amount
 * so the two stay in sync); `onChange` fires with the chosen percent.
 */
export function PercentSlider({
  value,
  onChange,
  disabled = false,
}: {
  value: number;
  onChange: (pct: number) => void;
  disabled?: boolean;
}) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="pct-slider">
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        className="pct-range"
        value={pct}
        disabled={disabled}
        aria-label="Amount as a percent of your balance"
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        style={{ ["--pct" as string]: `${pct}%` }}
      />
      <div className="pct-quick">
        {[25, 50, 75, 100].map((p) => (
          <button
            type="button"
            key={p}
            className={`pct-chip${pct === p ? " active" : ""}`}
            onClick={() => onChange(p)}
            disabled={disabled}
          >
            {p === 100 ? "MAX" : `${p}%`}
          </button>
        ))}
      </div>
    </div>
  );
}
