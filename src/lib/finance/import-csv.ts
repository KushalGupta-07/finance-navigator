import type { BankLine, Dataset, LedgerEntry, TruthLink } from "./data";

type CsvRow = Record<string, string>;

const normalizeHeader = (header: string) =>
  header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i++;
      row.push(cell.trim());
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell.trim());
  if (row.some((value) => value !== "")) rows.push(row);
  if (rows.length < 2) return [];

  const headers = rows[0]!.map(normalizeHeader);
  return rows.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
  );
}

const first = (row: CsvRow, ...keys: string[]) => {
  for (const key of keys) {
    if (row[key]?.trim()) return row[key]!.trim();
  }
  return "";
};

const amount = (value: string) => {
  const cleaned = value.replace(/[$€£,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
};

const dateValue = (value: string) => {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
};

const channelValue = (value: string): BankLine["channel"] => {
  const channel = value.toUpperCase();
  return ["ACH", "WIRE", "CARD", "CHECK"].includes(channel)
    ? (channel as BankLine["channel"])
    : "OTHER";
};

function rowType(row: CsvRow): "ledger" | "bank" | null {
  const explicit = first(row, "record_type", "source", "row_type", "dataset").toLowerCase();
  if (["ledger", "invoice", "bill", "book"].includes(explicit)) return "ledger";
  if (["bank", "statement", "transaction", "bank_line"].includes(explicit)) return "bank";

  const hasLedgerDate = Boolean(first(row, "issued_on", "issued", "invoice_date", "due_on"));
  const hasBankDate = Boolean(first(row, "posted_on", "posted", "transaction_date"));
  if (hasLedgerDate && !hasBankDate) return "ledger";
  if (hasBankDate && !hasLedgerDate) return "bank";
  if (first(row, "description") && !first(row, "counterparty")) return "bank";
  if (first(row, "counterparty")) return "ledger";
  return null;
}

export function parseFinanceCsv(text: string): Dataset {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new Error("The CSV is empty or has no data rows.");
  }

  const ledger: LedgerEntry[] = [];
  const bank: BankLine[] = [];
  const truth: TruthLink[] = [];
  const errors: string[] = [];
  let openingBalance = 0;
  let latestDate = "";

  rows.forEach((row, index) => {
    const line = index + 2;
    const type = rowType(row);
    const value = amount(first(row, "amount", "value", "total"));
    if (!type) {
      errors.push(`Row ${line}: add record_type as ledger or bank.`);
      return;
    }
    if (value === null) {
      errors.push(`Row ${line}: amount must be a number.`);
      return;
    }

    const opening = amount(first(row, "opening_balance", "opening_cash"));
    if (opening !== null && openingBalance === 0) openingBalance = opening;

    if (type === "ledger") {
      const issuedOn = dateValue(first(row, "issued_on", "issued", "invoice_date", "date"));
      const dueOn = dateValue(first(row, "due_on", "due_date")) ?? issuedOn;
      const counterparty = first(row, "counterparty", "vendor", "customer");
      if (!issuedOn || !counterparty) {
        errors.push(`Row ${line}: ledger rows need issued_on and counterparty.`);
        return;
      }
      const id = first(row, "id", "ledger_id") || `L-IMPORT-${ledger.length + 1}`;
      ledger.push({
        id,
        kind: first(row, "kind", "direction").toUpperCase() === "AP" || value < 0 ? "AP" : "AR",
        counterparty,
        memo: first(row, "memo", "reference", "invoice", "description") || id,
        amount: value,
        issuedOn,
        dueOn: dueOn ?? issuedOn,
        taxCode: first(row, "tax_code", "tax") || "UNSPECIFIED",
        currency: first(row, "currency") || "USD",
      });
      latestDate = latestDate > (dueOn ?? issuedOn) ? latestDate : dueOn ?? issuedOn;
      return;
    }

    const postedOn = dateValue(first(row, "posted_on", "posted", "transaction_date", "date"));
    const description = first(row, "description", "memo", "reference", "counterparty");
    if (!postedOn || !description) {
      errors.push(`Row ${line}: bank rows need posted_on and description.`);
      return;
    }
    const id = first(row, "id", "bank_id") || `B-IMPORT-${bank.length + 1}`;
    bank.push({
      id,
      postedOn,
      description,
      amount: value,
      channel: channelValue(first(row, "channel", "method")),
    });

    // Optional ground truth: expected_ledger_ids lists the ledger rows this bank
    // line should settle ("L-1|L-2", or "none" for a known unmatched line). When
    // provided, the accuracy report scores precision and recall against it.
    const expected = first(row, "expected_ledger_ids", "expected", "truth", "matches");
    if (expected) {
      const scenarioRaw = first(row, "scenario").toLowerCase();
      const scenarios: TruthLink["scenario"][] = [
        "clean",
        "date_drift",
        "bank_fee",
        "fx_rounding",
        "batch_payment",
        "duplicate_payment",
        "unknown_deposit",
      ];
      const scenario = scenarios.find((s) => s === scenarioRaw) ?? "clean";
      const ledgerIds =
        expected.toLowerCase() === "none"
          ? []
          : expected.split(/[|;]/).map((v) => v.trim()).filter(Boolean);
      truth.push({ bankId: id, ledgerIds, scenario });
    }
    latestDate = latestDate > postedOn ? latestDate : postedOn;
  });

  if (errors.length > 0) {
    throw new Error(errors.slice(0, 4).join(" ") + (errors.length > 4 ? " More rows need attention." : ""));
  }
  if (ledger.length === 0 || bank.length === 0) {
    throw new Error("The CSV must include at least one ledger row and one bank row.");
  }

  const knownLedgerIds = new Set(ledger.map((l) => l.id));
  const unknownIds = truth.flatMap((t) => t.ledgerIds).filter((id) => !knownLedgerIds.has(id));
  if (unknownIds.length > 0) {
    throw new Error(`expected_ledger_ids refers to unknown ledger rows: ${[...new Set(unknownIds)].slice(0, 4).join(", ")}.`);
  }

  return {
    ledger,
    bank: bank.sort((a, b) => a.postedOn.localeCompare(b.postedOn)),
    truth,
    openLedger: ledger,
    openingBalance,
    asOf: latestDate || new Date().toISOString().slice(0, 10),
    source: "imported",
  };
}

export const CSV_TEMPLATE =
  "record_type,id,kind,counterparty,memo,amount,issued_on,due_on,tax_code,currency,posted_on,description,channel,expected_ledger_ids,scenario\n" +
  "ledger,L-1,AR,Example Customer,Invoice 1001,1250.00,2026-08-01,2026-08-31,VAT-20,USD,,,,,\n" +
  "bank,B-1,,,,1250.00,,,,,2026-08-15,EXAMPLE CUSTOMER PMT 1001,ACH,L-1,clean\n" +
  "# expected_ledger_ids is optional: list the ledger ids a bank line should settle (L-1|L-2), or \"none\" for a known unmatched line. Supplying it enables the scored accuracy report.\n";