type Props = {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "positive" | "negative" | "warning";
};

const toneClass = {
  default: "text-foreground",
  positive: "text-positive",
  negative: "text-negative",
  warning: "text-warning",
} as const;

export function KpiTile({ label, value, sub, tone = "default" }: Props) {
  return (
    <div className="panel px-4 py-3">
      <p className="rule-label">{label}</p>
      <p className={`tabular mt-1 text-2xl font-semibold tracking-tight ${toneClass[tone]}`}>{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}
