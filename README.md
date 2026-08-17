# eval-llm-gate

A TypeScript foundation for evaluating and gating LLM outputs.

The project currently contains only the Node.js scaffold. Evaluation behavior,
model providers, and user-facing interfaces will be added separately.

## Requirements

- Node.js 22 or newer
- pnpm 10

## Setup

```sh
pnpm install
```

## Commands

- `pnpm dev` watches the source entrypoint.
- `pnpm build` compiles the package into `dist/`.
- `pnpm start` runs the compiled entrypoint.
- `pnpm test` runs the test suite once.
- `pnpm typecheck` checks TypeScript without emitting files.
- `pnpm lint` checks the source with ESLint.
- `pnpm format` formats the project with Prettier.
- `pnpm check` runs all validation and produces a clean build.
