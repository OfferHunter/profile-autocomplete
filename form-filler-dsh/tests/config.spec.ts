/**
 * Default-config resolution. Both the empty and the fully specified config are
 * exercised so every fallback in `resolveConfig` is covered without binding the
 * production port.
 */

import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/index.ts'

describe('resolveConfig', () => {
  it('defaults host, port, and cwd-relative snapshot and profile dirs', () => {
    expect(resolveConfig({})).toEqual({
      host: '127.0.0.1',
      port: 8765,
      runDir: 'runs',
      knowledgeDir: 'knowledge',
      attachmentsDir: 'attachments',
    })
  })

  it('keeps every explicit value', () => {
    expect(resolveConfig({
      host: '0.0.0.0',
      port: 9123,
      runDir: 'C:/runs',
      knowledgeDir: 'C:/knowledge',
      attachmentsDir: 'C:/attachments',
    })).toEqual({
      host: '0.0.0.0',
      port: 9123,
      runDir: 'C:/runs',
      knowledgeDir: 'C:/knowledge',
      attachmentsDir: 'C:/attachments',
    })
  })
})
