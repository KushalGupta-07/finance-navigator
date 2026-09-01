# Finance Navigator

Finance Navigator is an AI-assisted finance control dashboard for reconciliation, exception handling, and cash forecasting. It simulates a finance operations workflow where bank transactions are matched against ledger entries, mismatches are surfaced for review, and the system provides a self-scoring accuracy snapshot.

## What this project does

- Reconciles bank activity against ledger entries using a seeded finance dataset
- Scores match quality with auto-match rate, precision, recall, and exception counts
- Shows matched transactions, unresolved exceptions, and a cash forecast view
- Supports importing a custom CSV dataset for a real reconciliation batch
- Includes a built-in finance Q&A agent that answers questions using the current controller snapshot

## Key features

- AI Finance Controller dashboard
- Automated bank-to-ledger matching
- Exception tracking for ambiguous, duplicate, or unmatched entries
- Cash position and 8-week forecast analysis
- CSV template download and import workflow
- Server-side AI chat endpoint using a Lovable API key

## Tech stack

- React + TypeScript
- Vite
- TanStack Start / TanStack Router
- Tailwind CSS
- Recharts for financial charts
- AI SDK for the Q&A assistant

## Project structure

```bash
finance-navigator/
├── src/
│   ├── components/
│   ├── lib/
│   ├── routes/
│   ├── router.tsx
│   └── routeTree.gen.ts
├── public/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── README.md
└── AGENTS.md
```

## Getting started

Prerequisites:

- Node.js 18+ or later
- npm

Install dependencies:

```bash
npm install
```

Start the app locally:

```bash
npm run dev
```

Then open the local URL shown in the terminal in your browser.

## Local AI configuration

The finance Q&A agent calls Lovable AI from the server, so the API key must remain in a server-only environment variable and never be placed in browser code.

Create a `.env.local` file in the project root:

```bash
LOVABLE_API_KEY=your-lovable-ai-key
```

Restart the dev server after adding or changing the key. If the key is missing, the Q&A panel will display a configuration message instead of failing silently.

## Useful scripts

```bash
npm run dev      # start the development server
npm run build    # create a production build
npm run lint     # run ESLint checks
npm run format   # format the codebase with Prettier
```

## Notes

This app is designed as a finance operations mockup and demonstrates an AI-assisted reconciliation workflow rather than a production banking system. It is best suited for demos, prototypes, or educational exploration of AI-enabled finance automation.
