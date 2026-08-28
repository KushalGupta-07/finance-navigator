import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  Area,
  ComposedChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { KpiTile } from "@/components/finance/KpiTile";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { generateDataset } from "@/lib/finance/data";
import { ledgerLabel, reconcile } from "@/lib/finance/reconcile";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "AI Finance Controller — Reconciliation & Cash Position" },
      {
        name: "description",
        content:
          "An autonomous controller that reconciles a 50+ line bank statement against the ledger, scores its own match rate, and forecasts eight weeks of cash.",
      },
      { property: "og:title", content: "AI Finance Controller — Reconciliation & Cash Position" },
      {
        property: "og:description",
        content:
          "Throughput, measured accuracy, and an honest exception list: bank-to-ledger reconciliation with a self-scored accuracy report.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Controller,
});

const usd = (n: number) =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const usd2 = (n: number) =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const SCENARIO_LABEL: Record<string, string> = {
  clean: "Clean 1:1 settlements",
  date_drift: "Late settlement (>30d drift)",
  bank_fee: "Intermediary fee withheld",
  fx_rounding: "FX / rounding drift",
  batch_payment: "Batched multi-invoice transfer",
  duplicate_payment: "Duplicate payment (must NOT match)",
  unknown_deposit: "No ledger counterpart (must NOT match)",
};

const REASON_TONE: Record<string, string> = {
  AMBIGUOUS_DUPLICATE: "border-warning/50 text-warning",
  COUNTERPARTY_UNKNOWN: "border-border text-muted-foreground",
  AMOUNT_OUT_OF_TOLERANCE: "border-negative/50 text-negative",
  NO_CANDIDATE: "border-negative/50 text-negative",
};

function Controller() {
  const [seed, setSeed] = useState(20260828);
  const [tab, setTab] = useState("matches");
  const { ds, result } = useMemo(() => {
    const dataset = generateDataset(seed);
    return { ds: dataset, result: reconcile(dataset) };
  }, [seed]);

  const s = result.scorecard;
  const bankById = useMemo(() => new Map(ds.bank.map((b) => [b.id, b])), [ds]);

  return (
    <main className="mx-auto max-w-7xl px-5 py-10">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6">
        <div>
          <p className="rule-label">Autonomous finance ops · period close</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
            AI Finance Controller
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            One closed loop over {ds.bank.length} bank lines and {ds.ledger.length} ledger rows:
            match the books, score itself against ground truth, hand back everything it could not
            resolve, then project the cash position forward eight weeks.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="rule-label">Book as of</p>
            <p className="tabular text-sm">{ds.asOf}</p>
          </div>
          <Button onClick={() => setSeed((v) => v + 1)}>Run new batch</Button>
        </div>
      </header>

      <section className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-6">
        <KpiTile
          label="Auto-match rate"
          value={`${s.matchRatePct.toFixed(1)}%`}
          sub={`${s.autoMatched} of ${s.bankLines} bank lines`}
          tone="positive"
        />
        <KpiTile
          label="Precision"
          value={`${s.precisionPct.toFixed(1)}%`}
          sub={`${s.incorrect} wrong posting${s.incorrect === 1 ? "" : "s"}`}
          tone={s.incorrect === 0 ? "positive" : "warning"}
        />
        <KpiTile
          label="Recall"
          value={`${s.recallPct.toFixed(1)}%`}
          sub="of truly matchable lines"
        />
        <KpiTile
          label="Exceptions"
          value={String(result.exceptions.length)}
          sub="routed to a human"
          tone="warning"
        />
        <KpiTile
          label="Value cleared"
          value={usd(s.valueMatched)}
          sub={`of ${usd(s.valueTotal)} moved`}
        />
        <KpiTile
          label="Runtime"
          value={`${s.runtimeMs.toFixed(0)} ms`}
          sub={`${(s.bankLines / Math.max(s.runtimeMs, 0.01)) .toFixed(1)} lines/ms`}
        />
      </section>

      <Tabs value={tab} onValueChange={setTab} className="mt-8">
        <TabsList className="bg-secondary">
          <TabsTrigger value="matches">Matched ledger ({result.matches.length})</TabsTrigger>
          <TabsTrigger value="exceptions">Exceptions ({result.exceptions.length})</TabsTrigger>
          <TabsTrigger value="accuracy">Accuracy report</TabsTrigger>
          <TabsTrigger value="cash">Cash forecast</TabsTrigger>
        </TabsList>

        {/* ---------- matches ---------- */}
        <TabsContent value="matches" className="mt-4">
          <div className="panel overflow-hidden">
            <div className="max-h-[560px] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="rule-label border-b border-border text-left">
                    <th className="px-4 py-3 font-normal">Bank line</th>
                    <th className="px-4 py-3 font-normal">Posted</th>
                    <th className="px-4 py-3 text-right font-normal">Amount</th>
                    <th className="px-4 py-3 font-normal">Ledger</th>
                    <th className="px-4 py-3 font-normal">Tier</th>
                    <th className="px-4 py-3 text-right font-normal">Δ</th>
                    <th className="px-4 py-3 text-right font-normal">Conf.</th>
                    <th className="px-4 py-3 font-normal">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {result.matches.map((m) => {
                    const b = bankById.get(m.bankId)!;
                    return (
                      <tr key={m.bankId} className="border-b border-border/50 align-top">
                        <td className="tabular px-4 py-2.5">
                          <div>{m.bankId}</div>
                          <div className="text-xs text-muted-foreground">{b.description}</div>
                        </td>
                        <td className="tabular px-4 py-2.5 text-muted-foreground">{b.postedOn}</td>
                        <td
                          className={`tabular px-4 py-2.5 text-right ${b.amount < 0 ? "text-negative" : "text-positive"}`}
                        >
                          {usd2(b.amount)}
                        </td>
                        <td className="px-4 py-2.5 text-xs">
                          {m.ledgerIds.map((id) => (
                            <div key={id} className="tabular">
                              {ledgerLabel(ds, id)}
                            </div>
                          ))}
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge
                            variant="outline"
                            className={
                              m.tier === "exact"
                                ? "border-positive/50 text-positive"
                                : m.tier === "batch"
                                  ? "border-accent/50 text-accent"
                                  : "border-warning/50 text-warning"
                            }
                          >
                            {m.tier}
                          </Badge>
                        </td>
                        <td className="tabular px-4 py-2.5 text-right text-muted-foreground">
                          {m.amountDelta === 0 ? "—" : usd2(m.amountDelta)}
                        </td>
                        <td className="tabular px-4 py-2.5 text-right">
                          {(m.confidence * 100).toFixed(0)}%
                        </td>
                        <td className="max-w-[22rem] px-4 py-2.5 text-xs text-muted-foreground">
                          {m.rationale}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </TabsContent>

        {/* ---------- exceptions ---------- */}
        <TabsContent value="exceptions" className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            The controller refuses to post anything it cannot justify. These{" "}
            {result.exceptions.length} lines ({usd(
              result.exceptions.reduce((t, e) => t + Math.abs(e.amount), 0),
            )}
            ) stay open with a reason code and a next action.
          </p>
          {result.exceptions.map((e) => (
            <div key={e.bankId} className="panel px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <span className="tabular text-sm">{e.bankId}</span>
                  <Badge variant="outline" className={REASON_TONE[e.reason] ?? ""}>
                    {e.reason.replaceAll("_", " ").toLowerCase()}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{e.postedOn}</span>
                </div>
                <span className={`tabular ${e.amount < 0 ? "text-negative" : "text-positive"}`}>
                  {usd2(e.amount)}
                </span>
              </div>
              <p className="tabular mt-2 text-xs text-muted-foreground">{e.description}</p>
              <p className="mt-2 text-sm">{e.note}</p>
              <p className="mt-1 text-sm text-accent">→ {e.suggestion}</p>
            </div>
          ))}
          {result.falsePositives.length > 0 && (
            <div className="panel border-negative/40 px-4 py-3">
              <p className="rule-label text-negative">Self-audit: known bad postings</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Scored against ground truth, {result.falsePositives.length} auto-match
                {result.falsePositives.length === 1 ? " is" : "es are"} wrong. Reported rather than
                hidden.
              </p>
              {result.falsePositives.map((m) => (
                <p key={m.bankId} className="tabular mt-2 text-xs">
                  {m.bankId} → {m.ledgerIds.join(", ") || "(none)"} · {m.tier} ·{" "}
                  {(m.confidence * 100).toFixed(0)}% confidence
                </p>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ---------- accuracy ---------- */}
        <TabsContent value="accuracy" className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="panel px-5 py-4">
            <p className="rule-label">Coverage by injected scenario</p>
            <p className="mt-1 text-xs text-muted-foreground">
              The batch is generated with a known link map, so every distortion class can be scored
              independently — including the traps the agent is supposed to leave alone.
            </p>
            <div className="mt-4 space-y-3">
              {s.byScenario
                .filter((r) => r.total > 0)
                .map((r) => (
                  <div key={r.scenario}>
                    <div className="flex items-center justify-between text-sm">
                      <span>{SCENARIO_LABEL[r.scenario]}</span>
                      <span className="tabular text-muted-foreground">
                        {r.caught}/{r.total}
                      </span>
                    </div>
                    <Progress value={(r.caught / r.total) * 100} className="mt-1.5 h-1.5" />
                  </div>
                ))}
            </div>
          </div>
          <div className="panel px-5 py-4">
            <p className="rule-label">How the match was made</p>
            <div className="mt-4 grid grid-cols-3 gap-3">
              {(["exact", "tolerance", "batch"] as const).map((t) => (
                <div key={t} className="rounded-sm border border-border px-3 py-2">
                  <p className="tabular text-2xl">{s.byTier[t]}</p>
                  <p className="rule-label mt-1">{t}</p>
                </div>
              ))}
            </div>
            <dl className="mt-5 space-y-2 text-sm">
              {[
                ["Tier 1 — exact", "Amount identical to the cent, counterparty ≥50% token match, settled within 110 days."],
                ["Tier 2 — tolerance", "Amount within 1.5% (FX/rounding) or short by ≤$60 against the payment direction (intermediary fee)."],
                ["Tier 3 — batch", "Subset-sum across 2–3 open items from the same counterparty, to the cent."],
                ["Refuse", "Anything else. No ledger row is consumed twice, so split and duplicate settlements surface instead of silently absorbing."],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-foreground">{k}</dt>
                  <dd className="text-muted-foreground">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-5 border-t border-border pt-3 text-xs text-muted-foreground">
              Precision = correct postings ÷ postings made. Recall = correct postings ÷ lines that
              genuinely have a ledger counterpart. Both are computed against the generator's link
              map, not asserted.
            </p>
          </div>
        </TabsContent>

        {/* ---------- cash ---------- */}
        <TabsContent value="cash" className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <KpiTile label="Cleared cash position" value={usd(ds.openingBalance)} sub="post-reconciliation" />
            <KpiTile
              label="8-week projected close"
              value={usd(result.forecast[result.forecast.length - 1]!.closing)}
              tone={result.forecast[result.forecast.length - 1]!.closing > 0 ? "positive" : "negative"}
            />
            <KpiTile
              label="Downside floor"
              value={usd(result.runway.low)}
              sub={result.runway.weeks === 8 ? "no breach in horizon" : `low band breaches at week ${result.runway.weeks}`}
              tone={result.runway.weeks === 8 ? "positive" : "negative"}
            />
          </div>
          <div className="panel px-4 py-4">
            <p className="rule-label">Projected closing balance with confidence band</p>
            <div className="mt-4 h-[320px]">
              {tab === "cash" && (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={result.forecast}>
                  <defs>
                    <linearGradient id="band" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--grid)" vertical={false} />
                  <XAxis dataKey="weekOf" stroke="var(--muted-foreground)" fontSize={11} />
                  <YAxis
                    stroke="var(--muted-foreground)"
                    fontSize={11}
                    tickFormatter={(v: number) => `${Math.round(v / 1000)}k`}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--card)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                    formatter={(v: number, n: string) => [usd(v), n === "bandHeight" ? "band width" : n]}
                  />
                  <Area
                    type="monotone"
                    dataKey="low"
                    stackId="band"
                    stroke="none"
                    fill="none"
                    isAnimationActive={false}
                  />
                  <Area
                    type="monotone"
                    dataKey="bandHeight"
                    stackId="band"
                    stroke="none"
                    fill="url(#band)"
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="closing"
                    stroke="var(--primary)"
                    strokeWidth={2}
                    dot={{ r: 2.5, fill: "var(--primary)", stroke: "none" }}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
              )}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Timing is learned from the settlement delays observed in this batch; receivables carry
              a 12% late/short-pay haircut and a fixed weekly run-rate of {usd(38500)} is applied.
              Only open items that survived reconciliation are forecast — matched lines are already
              in the cleared balance.
            </p>
          </div>
        </TabsContent>
      </Tabs>

      <footer className="mt-10 border-t border-border pt-4 text-xs text-muted-foreground">
        Synthetic batch, deterministic seed {seed}. {ds.bank.length} bank lines · {ds.ledger.length}{" "}
        ledger rows · {result.matches.length} auto-posted · {result.exceptions.length} escalated ·{" "}
        {s.incorrect} self-reported error{s.incorrect === 1 ? "" : "s"}.
      </footer>
    </main>
  );
}
