// config.ts needs the same env the app bootstraps from; several modules read it
// at import time.
import './apps/bff/src/env.ts';

// Extends `expect` with DOM matchers (.toBeInTheDocument(), etc.) for
// apps/web's component tests. A no-op import for backend tests.
import '@testing-library/jest-dom/vitest';

import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Every test gets a fresh in-memory SQLite database, never the real
// data/rumble.db. What matters is that this runs before any test file's own
// imports — config.ts reads DATABASE_PATH once, on first import. Its position
// relative to the env.ts import above is not a choice: ESM hoists imports above
// statements, so env.ts has already run by the time this line does.
process.env.DATABASE_PATH = ':memory:';

// @testing-library/react's auto-cleanup normally hooks the global afterEach,
// which only exists with `test.globals: true` — we don't use that (explicit
// `import { ... } from 'vitest'` everywhere instead), so without this,
// rendered component trees from one test leak into the next test in the
// same file.
afterEach(cleanup);
