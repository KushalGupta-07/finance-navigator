// Deterministic reconciliation engine + self-scoring against ground truth,
// plus a forward 8-week cash forecast built from unmatched open items.

import type { BankLine, Dataset, LedgerEntry, TruthLink } from "./data";

const DAY = 86_400_000;

export type ReasonCode =
  | "MATCHED_EXACT"
  | "MATCHED_TOLERANCE"
  | "MATCHED_BATCH"
  | "NO_CANDIDATE"
  | "AMOUNT_OUT_OF_TOLERANCE"
  | "AMBIGUOUS_DUPLICATE"
  | "COUNTERPARTY_UNKNOWN";

export type MatchTier = "exact" | "tolerance" | "batch";

export type Match = {
  bankId: string;
  ledgerIds: string[];
  tier: MatchTier;
  confidence: number; // 0..1
  amountDelta: number;
  dayGap: number;
  rationale: string;
};

export type Exception = {
  bankId: string;
  reason: ReasonCode;
  amount: number;
  postedOn: string;
  description: string;
  note: string;
  suggestion: string;
};

export type Scorecard = {
  bankLines: number;
  ledgerRows: number;
  autoMatched: number;
  matchRatePct: number;
  correct: number;
  incorrect: number;
  precisionPct: number;
  recallPct: number;
  valueMatched: number;
  valueTotal: number;
  runtimeMs: number;
  byTier: Record<MatchTier, number>;
  byScenario: { scenario: TruthLink["scenario"]; total: number; caught: number }[];
};

export type ForecastPoint = {
  weekOf: string;
  inflow: number;
  outflow: number;
  closing: number;
  low: number;
  high: number;
  bandHeight: number; // high - low, for stacked band rendering
};

export type ReconResult = {
  matches: Match[];
  exceptions: Exception[];
  falsePositives: Match[];
  scorecard: Scorecard;
  forecast: ForecastPoint[];
  runway: { weeks: number; low: number };
};

/* ---------- helpers ---------- */

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b(inc|llp|llc|ltd|group|svcs|services|pmt|ach|credit|wire|ref|inv|batch)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Token + prefix similarity tolerant of bank truncation and concatenation. */
function nameSimilarity(ledgerName: string, bankDesc: string): number {
  const a = norm(ledgerName);
  const b = norm(bankDesc);
  if (!a || !b) return 0;
  const squashedB = b.replace(/ /g, "");
  const tokens = a.split(" ").filter((t) => t.length > 2);
  if (tokens.length === 0) return 0;
  let hit = 0;
  for (const t of tokens) {
    if (squashedB.includes(t)) hit += 1;
    else if (t.length >= 6 && squashedB.includes(t.slice(0, 5))) hit += 0.75;
    else if (squashedB.includes(t.slice(0, 4))) hit += 0.4;
  }
  return Math.min(1, hit / tokens.length);
}

const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);
const round2 = (n: number) => Math.round(n * 100) / 100;
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

/* ---------- engine ---------- */

export function reconcile(ds: Dataset): ReconResult {
  const started =
    typeof performance !== "undefined" ? performance.now() : Date.now();

  const ledgerById = new Map(ds.ledger.map((l) => [l.id, l]));
  const takenLedger = new Set<string>();
  const matches: Match[] = [];

  type Cand = {
    bank: BankLine;
    entry: LedgerEntry;
    tier: MatchTier;
    score: number;
    amountDelta: number;
    dayGap: number;
    rationale: string;
  };

  const cands: Cand[] = [];
  for (const bank of ds.bank) {
    for (const entry of ds.ledger) {
      if (Math.sign(bank.amount) !== Math.sign(entry.amount)) continue;
      const gap = days(entry.issuedOn, bank.postedOn);
      if (gap < -2 || gap > 110) continue;
      const sim = nameSimilarity(entry.counterparty, bank.description);
      if (sim < 0.5) continue;

      const delta = round2(bank.amount - entry.amount);
      const rel = Math.abs(delta) / Math.max(1, Math.abs(entry.amount));
      const feeLike = Math.abs(delta) <= 60 && Math.sign(delta) !== Math.sign(entry.amount);

      let tier: MatchTier | null = null;
      let rationale = "";
      if (Math.abs(delta) <= 0.01) {
        tier = "exact";
        rationale = `Amount identical, counterparty ${(sim * 100).toFixed(0)}% match, settled in ${gap}d`;
      } else if (rel <= 0.015 || feeLike) {
        tier = "tolerance";
        rationale = feeLike
          ? `Fee-adjusted: bank short by ${Math.abs(delta).toFixed(2)} (intermediary fee), ${gap}d gap`
          : `FX/rounding drift of ${(rel * 100).toFixed(2)}% within 1.5% tolerance, ${gap}d gap`;
      }
      if (!tier) continue;

      const timeScore = gap <= 45 ? 1 : Math.max(0, 1 - (gap - 45) / 90);
      const amtScore = 1 - Math.min(1, rel / 0.015);
      const score =
        (tier === "exact" ? 0.6 : 0.42) + 0.22 * sim + 0.12 * timeScore + 0.1 * amtScore;

      cands.push({ bank, entry, tier, score: Math.min(0.99, score), amountDelta: delta, dayGap: gap, rationale });
    }
  }

  cands.sort((a, b) => b.score - a.score || a.bank.id.localeCompare(b.bank.id));
  const matchedBank = new Set<string>();
  for (const c of cands) {
    if (matchedBank.has(c.bank.id) || takenLedger.has(c.entry.id)) continue;
    matchedBank.add(c.bank.id);
    takenLedger.add(c.entry.id);
    matches.push({
      bankId: c.bank.id,
      ledgerIds: [c.entry.id],
      tier: c.tier,
      confidence: round2(c.score),
      amountDelta: c.amountDelta,
      dayGap: c.dayGap,
      rationale: c.rationale,
    });
  }

  // Pass 2: batch payments — subset sum (size 2-3) over one counterparty.
  for (const bank of ds.bank) {
    if (matchedBank.has(bank.id)) continue;
    const pool = ds.ledger.filter(
      (e) =>
        !takenLedger.has(e.id) &&
        Math.sign(e.amount) === Math.sign(bank.amount) &&
        nameSimilarity(e.counterparty, bank.description) >= 0.6 &&
        days(e.issuedOn, bank.postedOn) >= -2 &&
        days(e.issuedOn, bank.postedOn) <= 130,
    );
    let found: LedgerEntry[] | null = null;
    for (let i = 0; i < pool.length && !found; i++) {
      for (let j = i + 1; j < pool.length && !found; j++) {
        if (Math.abs(pool[i]!.amount + pool[j]!.amount - bank.amount) <= 0.02) {
          found = [pool[i]!, pool[j]!];
          break;
        }
        for (let k = j + 1; k < pool.length; k++) {
          if (Math.abs(pool[i]!.amount + pool[j]!.amount + pool[k]!.amount - bank.amount) <= 0.02) {
            found = [pool[i]!, pool[j]!, pool[k]!];
            break;
          }
        }
      }
    }
    if (found) {
      found.forEach((e) => takenLedger.add(e.id));
      matchedBank.add(bank.id);
      matches.push({
        bankId: bank.id,
        ledgerIds: found.map((e) => e.id),
        tier: "batch",
        confidence: 0.86,
        amountDelta: round2(bank.amount - found.reduce((s, e) => s + e.amount, 0)),
        dayGap: days(found[0]!.issuedOn, bank.postedOn),
        rationale: `Subset-sum: ${found.length} ${found[0]!.counterparty} items settled in one transfer`,
      });
    }
  }

  // Exceptions: everything the engine refused to auto-post.
  const exceptions: Exception[] = [];
  for (const bank of ds.bank) {
    if (matchedBank.has(bank.id)) continue;
    const near = ds.ledger
      .map((e) => ({ e, sim: nameSimilarity(e.counterparty, bank.description) }))
      .filter((x) => x.sim >= 0.5)
      .sort((a, b) => b.sim - a.sim);

    const dupOf = matches.find((m) => {
      const line = ds.bank.find((b) => b.id === m.bankId)!;
      return (
        Math.abs(line.amount - bank.amount) <= 0.01 &&
        norm(line.description).slice(0, 10) === norm(bank.description).slice(0, 10)
      );
    });

    let reason: ReasonCode;
    let note: string;
    let suggestion: string;
    if (dupOf) {
      reason = "AMBIGUOUS_DUPLICATE";
      note = `Identical amount and counterparty to ${dupOf.bankId}, already matched to ${dupOf.ledgerIds.join(", ")}.`;
      suggestion = "Confirm with the vendor whether a duplicate payment was issued, then request recall.";
    } else if (near.length === 0) {
      reason = "COUNTERPARTY_UNKNOWN";
      note = "No ledger counterparty resembles this description.";
      suggestion = "Code manually to a GL account (interest, processor payout, or chargeback).";
    } else {
      const best = near[0]!.e;
      const delta = round2(bank.amount - best.amount);
      if (takenLedger.has(best.id)) {
        reason = "NO_CANDIDATE";
        note = `Closest ledger row ${best.id} is already consumed by another bank line.`;
        suggestion = "Check for a split settlement or a missing invoice in the ledger.";
      } else {
        reason = "AMOUNT_OUT_OF_TOLERANCE";
        note = `Nearest candidate ${best.id} (${best.memo}) differs by ${delta.toFixed(2)} — beyond the 1.5% / $60 fee band.`;
        suggestion = "Investigate short-pay, credit note, or partial settlement before posting.";
      }
    }
    exceptions.push({
      bankId: bank.id,
      reason,
      amount: bank.amount,
      postedOn: bank.postedOn,
      description: bank.description,
      note,
      suggestion,
    });
  }

  /* ---------- scoring against ground truth ---------- */

  const truthByBank = new Map(ds.truth.map((t) => [t.bankId, t]));
  let correct = 0;
  const falsePositives: Match[] = [];
  for (const m of matches) {
    const t = truthByBank.get(m.bankId);
    if (t && sameSet(t.ledgerIds, m.ledgerIds)) correct += 1;
    else falsePositives.push(m);
  }
  const matchableTotal = ds.truth.filter((t) => t.ledgerIds.length > 0).length;
  const valueTotal = ds.bank.reduce((s, b) => s + Math.abs(b.amount), 0);
  const valueMatched = matches.reduce(
    (s, m) => s + Math.abs(ds.bank.find((b) => b.id === m.bankId)!.amount),
    0,
  );

  const scenarios: TruthLink["scenario"][] = [
    "clean",
    "date_drift",
    "bank_fee",
    "fx_rounding",
    "batch_payment",
    "duplicate_payment",
    "unknown_deposit",
  ];
  const matchByBank = new Map(matches.map((m) => [m.bankId, m]));
  const byScenario = scenarios.map((scenario) => {
    const rows = ds.truth.filter((t) => t.scenario === scenario);
    const caught = rows.filter((t) => {
      const m = matchByBank.get(t.bankId);
      // For unmatched-by-design rows, "caught" means correctly left as an exception.
      return t.ledgerIds.length === 0 ? !m : !!m && sameSet(m.ledgerIds, t.ledgerIds);
    }).length;
    return { scenario, total: rows.length, caught };
  });

  const runtimeMs =
    (typeof performance !== "undefined" ? performance.now() : Date.now()) - started;

  const scorecard: Scorecard = {
    bankLines: ds.bank.length,
    ledgerRows: ds.ledger.length,
    autoMatched: matches.length,
    matchRatePct: round2((matches.length / ds.bank.length) * 100),
    correct,
    incorrect: falsePositives.length,
    precisionPct: matches.length ? round2((correct / matches.length) * 100) : 0,
    recallPct: matchableTotal ? round2((correct / matchableTotal) * 100) : 0,
    valueMatched: round2(valueMatched),
    valueTotal: round2(valueTotal),
    runtimeMs: Math.round(runtimeMs * 100) / 100,
    byTier: {
      exact: matches.filter((m) => m.tier === "exact").length,
      tolerance: matches.filter((m) => m.tier === "tolerance").length,
      batch: matches.filter((m) => m.tier === "batch").length,
    },
    byScenario,
  };

  /* ---------- forward cash forecast ---------- */

  // Observed settlement delay (issued -> posted) drives the expected timing of open items.
  const observedGaps = matches.map((m) => m.dayGap).sort((a, b) => a - b);
  const medianGap = observedGaps.length ? observedGaps[Math.floor(observedGaps.length / 2)]! : 30;

  const open = [
    ...ds.openLedger,
    ...ds.ledger.filter((e) => !takenLedger.has(e.id) && !ds.openLedger.includes(e)),
  ];
  const asOfT = Date.parse(ds.asOf);
  const weeklyOpex = -38_500; // payroll + fixed run-rate

  const forecast: ForecastPoint[] = [];
  let balance = ds.openingBalance;
  let spread = 0;
  for (let w = 0; w < 8; w++) {
    const start = asOfT + w * 7 * DAY;
    const end = start + 7 * DAY;
    let inflow = 0;
    let outflow = weeklyOpex;
    for (const e of open) {
      // Open items are expected on their due date plus the observed late-pay drift,
      // never earlier than the reporting date.
      const lateDrift = Math.max(0, medianGap - 30);
      const due = Date.parse(e.dueOn) + lateDrift * DAY;
      // Already-overdue items are chased over the first three weeks, not all at once.
      const overdueSlot = (Number(e.id.replace(/\D/g, "")) % 3) * 7 + 3;
      const expected = due >= asOfT ? due : asOfT + overdueSlot * DAY;
      if (expected >= start && expected < end) {
        if (e.amount > 0) inflow += e.amount * 0.92; // haircut for late/short pay
        else outflow += e.amount;
      }
    }
    balance += inflow + outflow;
    spread += Math.abs(inflow) * 0.12 + 6_000;
    forecast.push({
      weekOf: new Date(start).toISOString().slice(0, 10),
      inflow: round2(inflow),
      outflow: round2(outflow),
      closing: round2(balance),
      low: round2(balance - spread),
      high: round2(balance + spread),
      bandHeight: round2(2 * spread),
    });
  }

  const firstNeg = forecast.findIndex((p) => p.low < 0);
  const runway = {
    weeks: firstNeg === -1 ? 8 : firstNeg,
    low: Math.min(...forecast.map((p) => p.low)),
  };

  return { matches, exceptions, falsePositives, scorecard, forecast, runway };
}

export function ledgerLabel(ds: Dataset, id: string) {
  const e = ds.ledger.find((l) => l.id === id);
  return e ? `${e.id} · ${e.counterparty} · ${e.memo}` : id;
}
export type { LedgerEntry, BankLine };
