// Synthetic finance-ops dataset generator (deterministic, seeded).
// Produces a ledger (AR/AP) and a bank statement derived from it, with a
// known ground-truth link map so the reconciliation engine can be scored.

export type LedgerEntry = {
  id: string;
  kind: "AR" | "AP";
  counterparty: string;
  memo: string;
  amount: number; // positive = money in (AR), negative = money out (AP)
  issuedOn: string; // ISO date
  dueOn: string;
  taxCode: string;
  currency: "USD";
};

export type BankLine = {
  id: string;
  postedOn: string;
  description: string;
  amount: number;
  channel: "ACH" | "WIRE" | "CARD" | "CHECK";
};

export type TruthLink = {
  bankId: string;
  ledgerIds: string[];
  scenario:
    | "clean"
    | "date_drift"
    | "bank_fee"
    | "fx_rounding"
    | "batch_payment"
    | "duplicate_payment"
    | "unknown_deposit";
};

export type Dataset = {
  ledger: LedgerEntry[];
  bank: BankLine[];
  truth: TruthLink[];
  openLedger: LedgerEntry[]; // ledger rows with no bank line at all
  openingBalance: number;
  asOf: string;
};

const COUNTERPARTIES = [
  "Northwind Logistics",
  "Helix Biotech",
  "Cobalt Studios",
  "Arcadia Foods",
  "Vector Cloud Inc",
  "Palermo Freight",
  "Ridgeline Legal LLP",
  "Beacon Analytics",
  "Solstice Manufacturing",
  "Kestrel Media Group",
  "Granite Facilities",
  "Lumen Payroll Svcs",
];

const AP_VENDORS = new Set([
  "Vector Cloud Inc",
  "Ridgeline Legal LLP",
  "Granite Facilities",
  "Lumen Payroll Svcs",
  "Palermo Freight",
]);

const TAX_CODES = ["VAT-20", "VAT-0", "US-SALES", "REV-CHG", "EXEMPT"];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Bank descriptions are messy on purpose: truncation, casing, refs, noise. */
function bankDescription(name: string, rnd: () => number, ref: string) {
  const upper = name.toUpperCase().replace(/[.,]/g, "");
  const variants = [
    `${upper} PMT ${ref}`,
    `${upper.slice(0, 14)}* ${ref}`,
    `ACH CREDIT ${upper.split(" ")[0]} ${ref}`,
    `${upper.replace(/\s+/g, "")} REF${ref}`,
    `${upper} INV ${ref}`,
  ];
  return variants[Math.floor(rnd() * variants.length)]!;
}

export function generateDataset(seed = 20260828): Dataset {
  const rnd = mulberry32(seed);
  const asOfT = Date.UTC(2026, 7, 28);
  const ledger: LedgerEntry[] = [];
  const bank: BankLine[] = [];
  const truth: TruthLink[] = [];

  const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)]!;
  const money = (lo: number, hi: number) => Math.round((lo + rnd() * (hi - lo)) * 100) / 100;

  // 1. Build the ledger.
  const LEDGER_N = 58;
  for (let i = 0; i < LEDGER_N; i++) {
    const counterparty = pick(COUNTERPARTIES);
    const kind: "AR" | "AP" = AP_VENDORS.has(counterparty) ? "AP" : "AR";
    const issued = asOfT - Math.floor(rnd() * 75 + 5) * DAY;
    const terms = pick([14, 30, 30, 45, 60]);
    const gross = money(kind === "AR" ? 1800 : 600, kind === "AR" ? 42000 : 19000);
    ledger.push({
      id: `L-${String(1000 + i)}`,
      kind,
      counterparty,
      memo: `${kind === "AR" ? "Invoice" : "Bill"} ${2600 + i}`,
      amount: kind === "AR" ? gross : -gross,
      issuedOn: iso(issued),
      dueOn: iso(issued + terms * DAY),
      taxCode: pick(TAX_CODES),
      currency: "USD",
    });
  }

  // 2. Derive bank lines with realistic distortions.
  const unpaid: LedgerEntry[] = [];
  const used = new Set<string>();
  let bankSeq = 0;
  const nextBankId = () => `B-${String(5000 + bankSeq++)}`;

  const post = (entry: LedgerEntry, shiftDays: number) =>
    iso(Date.parse(entry.issuedOn) + shiftDays * DAY);

  for (let i = 0; i < ledger.length; i++) {
    const entry = ledger[i]!;
    if (used.has(entry.id)) continue;
    const roll = rnd();

    // ~10%: never hits the bank in this window -> open item, feeds the forecast.
    if (roll > 0.9) {
      unpaid.push(entry);
      used.add(entry.id);
      continue;
    }

    const ref = String(700000 + Math.floor(rnd() * 99999));

    // Batch payment: one bank line settles 2-3 invoices from the same counterparty.
    if (roll > 0.8) {
      const siblings = ledger
        .slice(i + 1)
        .filter((e) => !used.has(e.id) && e.counterparty === entry.counterparty && e.kind === entry.kind)
        .slice(0, rnd() > 0.5 ? 2 : 1);
      if (siblings.length > 0) {
        const group = [entry, ...siblings];
        group.forEach((e) => used.add(e.id));
        const total = Math.round(group.reduce((s, e) => s + e.amount, 0) * 100) / 100;
        const id = nextBankId();
        bank.push({
          id,
          postedOn: post(entry, 12 + Math.floor(rnd() * 20)),
          description: bankDescription(entry.counterparty, rnd, `BATCH${ref}`),
          amount: total,
          channel: "ACH",
        });
        truth.push({ bankId: id, ledgerIds: group.map((e) => e.id), scenario: "batch_payment" });
        continue;
      }
    }

    used.add(entry.id);
    const id = nextBankId();
    let amount = entry.amount;
    let scenario: TruthLink["scenario"] = "clean";
    let drift = 8 + Math.floor(rnd() * 22);

    if (roll > 0.72) {
      // Bank fee withheld by the intermediary.
      const fee = Math.round(Math.min(45, Math.max(12, Math.abs(amount) * 0.0025)) * 100) / 100;
      amount = Math.round((amount - Math.sign(amount) * fee) * 100) / 100;
      scenario = "bank_fee";
    } else if (roll > 0.62) {
      // Cross-border FX rounding drift.
      amount = Math.round(amount * (1 + (rnd() - 0.5) * 0.011) * 100) / 100;
      scenario = "fx_rounding";
    } else if (roll > 0.5) {
      drift = 34 + Math.floor(rnd() * 26); // settles far outside terms
      scenario = "date_drift";
    }

    bank.push({
      id,
      postedOn: post(entry, drift),
      description: bankDescription(entry.counterparty, rnd, ref),
      amount,
      channel: pick(["ACH", "WIRE", "CARD", "CHECK"]),
    });
    truth.push({ bankId: id, ledgerIds: [entry.id], scenario });

    // Duplicate payment: same amount posted twice, only one is real.
    if (rnd() > 0.88) {
      const dupId = nextBankId();
      bank.push({
        id: dupId,
        postedOn: post(entry, drift + 1),
        description: bankDescription(entry.counterparty, rnd, ref),
        amount,
        channel: "ACH",
      });
      truth.push({ bankId: dupId, ledgerIds: [], scenario: "duplicate_payment" });
    }
  }

  // 3. Bank lines with no ledger counterpart at all.
  for (let i = 0; i < 4; i++) {
    const id = nextBankId();
    bank.push({
      id,
      postedOn: iso(asOfT - Math.floor(rnd() * 40) * DAY),
      description: pick([
        "INTEREST CREDIT Q3",
        "CHARGEBACK ADJ 4471",
        "STRIPE PAYOUT 88231",
        "MERCHANT FEE REBATE",
      ]),
      amount: money(120, 4200) * (rnd() > 0.35 ? 1 : -1),
      channel: "ACH",
    });
    truth.push({ bankId: id, ledgerIds: [], scenario: "unknown_deposit" });
  }

  bank.sort((a, b) => a.postedOn.localeCompare(b.postedOn));

  return {
    ledger,
    bank,
    truth,
    openLedger: unpaid,
    openingBalance: 412_500,
    asOf: iso(asOfT),
  };
}
