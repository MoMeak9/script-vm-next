import { vi } from 'vitest'
import type { ProgramArtifact } from '../compiler/types'

// Only the test harness can change the default runtime. Production compilation
// never reads this environment variable; explicit API options still win here.
vi.mock('../compiler/pack', async importOriginal => {
  const actual = await importOriginal<typeof import('../compiler/pack')>()
  if (process.env.SCRIPT_VM_TEST_RUNTIME !== 'full') return actual
  return {
    ...actual,
    packArtifact: (artifact: ProgramArtifact, runtime?: 'auto' | 'full') =>
      actual.packArtifact(artifact, runtime ?? 'full'),
  }
})
