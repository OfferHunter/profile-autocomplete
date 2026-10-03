/**
 * Default-config resolution. Both the empty and the fully specified config are
 * exercised so every fallback in `resolveConfig` is covered without binding the
 * production port.
 */

import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/index.ts'

let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(resolve('.'), 'tmp-dsh-home')
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})

describe('resolveConfig', () => {
  it('defaults host, port, and the two paths below DSH_HOME', () => {
    const home = resolve(process.env.DSH_HOME!)
    expect(resolveConfig({})).toEqual({
      host: '127.0.0.1',
      port: 8765,
      runDir: join(home, 'form-filler', 'runs'),
      knowledgeDir: join(home, 'form-filler', 'knowledge'),
    })
  })

  it('keeps every explicit value', () => {
    expect(resolveConfig({
      host: '0.0.0.0',
      port: 9123,
      runDir: 'C:/runs',
      knowledgeDir: 'C:/knowledge',
    })).toEqual({
      host: '0.0.0.0',
      port: 9123,
      runDir: 'C:/runs',
      knowledgeDir: 'C:/knowledge',
    })
  })
})
