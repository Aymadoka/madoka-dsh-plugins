import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  buildUntrackedPatch,
  collectCommitDiff,
  splitNulPaths,
  SINGLE_DIFF_MAX_LENGTH,
} from '../src/lib/diff.js'
import {
  collectProjectRules,
  detectRulesLanguage,
  RULES_MAX_LENGTH,
} from '../src/lib/rules.js'
import {
  buildCommitSystemPrompt,
  buildCommitUserPrompt,
  generateCommitMessage,
  MSG_FENCE,
  parseCommitMessage,
  resolveRoute,
} from '../src/lib/commitMessage.js'
import type { CommitMessageInput, GenerateCommitMessageResult } from '../src/lib/commitMessage.js'
import { formatCommitMessageReport, runCommitMessage } from '../src/lib/pipeline.js'
import { FakeFs, FakeRunner, ok } from './helpers.js'

const WORKDIR = process.platform === 'win32' ? 'C:\\repo' : '/repo'
const signal = new AbortController().signal

function nameOnly(list: readonly string[]): string {
  return list.length === 0 ? '' : `${list.join('\0')}\0`
}

describe('splitNulPaths', () => {
  it('keeps paths verbatim and drops the trailing empty entry', () => {
    assert.deepEqual(splitNulPaths('a b.ts\0c.ts\0'), ['a b.ts', 'c.ts'])
    assert.deepEqual(splitNulPaths(''), [])
  })
})

describe('buildUntrackedPatch', () => {
  it('synthesizes a new-file patch with a real line count', async () => {
    const fs = new FakeFs()
    fs.files.set(resolve(WORKDIR, 'new.ts'), 'l1\nl2\n')
    const patch = await buildUntrackedPatch(fs, WORKDIR, 'new.ts', 1_000)
    assert.ok(patch !== undefined)
    assert.ok(patch.includes('diff --git a/new.ts b/new.ts'))
    assert.ok(patch.includes('@@ -0,0 +1,2 @@'))
    assert.ok(patch.includes('+l1\n+l2'))
  })

  it('skips binary content and oversized files', async () => {
    const binary = new FakeFs()
    binary.files.set(resolve(WORKDIR, 'bin.dat'), 'a\0b')
    assert.equal(await buildUntrackedPatch(binary, WORKDIR, 'bin.dat', 1_000), undefined)

    const big = new FakeFs()
    big.files.set(resolve(WORKDIR, 'big.txt'), 'abcdef')
    assert.equal(await buildUntrackedPatch(big, WORKDIR, 'big.txt', 2), undefined)
  })

  it('returns undefined for a missing file', async () => {
    assert.equal(await buildUntrackedPatch(new FakeFs(), WORKDIR, 'gone.ts', 1_000), undefined)
  })
})

describe('collectCommitDiff', () => {
  it('prefers the staged area when anything is staged', async () => {
    const runner = new FakeRunner().on('diff', (argv) =>
      argv.includes('--name-only')
        ? ok(nameOnly(['a.ts']))
        : ok('diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new'),
    )
    const result = await collectCommitDiff(runner, new FakeFs(), WORKDIR)
    assert.equal(result.source, 'staged')
    assert.equal(result.fileCount, 1)
    assert.equal(result.candidateCount, 1)
    assert.ok(result.diff.includes('+new'))
  })

  it('falls back to tracked + untracked and synthesizes the untracked patch', async () => {
    const fs = new FakeFs()
    fs.files.set(resolve(WORKDIR, 'new.ts'), 'l1\nl2\n')
    const runner = new FakeRunner()
      .on('diff', (argv) => {
        if (!argv.includes('--name-only')) return ok('diff --git a/mod.ts b/mod.ts\n+x')
        // 暂存探测必须为空，才会走工作区分支。
        return argv.includes('--cached') ? ok('') : ok(nameOnly(['mod.ts']))
      })
      .on('ls-files', ok(nameOnly(['new.ts'])))

    const result = await collectCommitDiff(runner, fs, WORKDIR)
    assert.equal(result.source, 'worktree')
    assert.equal(result.fileCount, 2)
    assert.ok(result.diff.includes('@@ -0,0 +1,2 @@'))
    assert.ok(result.diff.includes('+l1'))
  })

  it('drops a single diff over the per-file cap', async () => {
    const runner = new FakeRunner().on('diff', (argv) =>
      argv.includes('--name-only') ? ok(nameOnly(['a.ts'])) : ok('x'.repeat(60)),
    )
    const result = await collectCommitDiff(runner, new FakeFs(), WORKDIR, { singleDiffMaxLength: 10 })
    assert.equal(result.fileCount, 0)
    assert.equal(result.droppedSingle, 1)
    assert.equal(result.diff, '')
  })

  it('stops at the total cap and reports how many were dropped', async () => {
    const patch = 'y'.repeat(100)
    const runner = new FakeRunner().on('diff', (argv) => {
      if (argv.includes('--name-only')) return ok(nameOnly(['a.ts', 'b.ts', 'c.ts']))
      return ok(patch)
    })
    const result = await collectCommitDiff(runner, new FakeFs(), WORKDIR, { diffMaxLength: 150 })
    assert.equal(result.fileCount, 1)
    assert.equal(result.droppedTotal, 2)
    assert.equal(result.diff.length, 100)
  })

  it('exposes Trae-compatible default caps', () => {
    assert.equal(SINGLE_DIFF_MAX_LENGTH, 50_000)
  })
})

describe('collectProjectRules', () => {
  it('reads AGENTS.md in the Trae rule-file format', async () => {
    const fs = new FakeFs()
    fs.files.set(join(WORKDIR, 'AGENTS.md'), '# 规则\n用中文写提交信息\n')
    const rules = await collectProjectRules(fs, WORKDIR)
    assert.deepEqual(rules.files, ['AGENTS.md'])
    assert.equal(rules.truncated, false)
    assert.ok(rules.text.startsWith('Rule File: AGENTS.md\n'))
    assert.ok(rules.text.includes('用中文写提交信息'))
  })

  it('returns empty rules when no rule file exists', async () => {
    const rules = await collectProjectRules(new FakeFs(), WORKDIR)
    assert.deepEqual(rules, { text: '', files: [], truncated: false })
  })

  it('truncates with the [...] mark and respects the cap', async () => {
    const fs = new FakeFs()
    fs.files.set(join(WORKDIR, 'AGENTS.md'), 'x'.repeat(200))
    const rules = await collectProjectRules(fs, WORKDIR, 50)
    assert.equal(rules.truncated, true)
    assert.ok(rules.text.endsWith('[...]'))
    assert.ok(rules.text.length <= 50)
  })

  it('rejects a non-positive cap', async () => {
    const fs = new FakeFs()
    fs.files.set(join(WORKDIR, 'AGENTS.md'), 'x')
    assert.deepEqual(await collectProjectRules(fs, WORKDIR, 0), { text: '', files: [], truncated: false })
  })

  it('exposes the Trae-compatible default cap', () => {
    assert.equal(RULES_MAX_LENGTH, 5_000)
  })
})

describe('detectRulesLanguage', () => {
  it('detects Chinese rules despite the ASCII rule header', () => {
    const text = 'Rule File: AGENTS.md\n用中文写提交信息'
    assert.equal(detectRulesLanguage({ text, files: ['AGENTS.md'], truncated: false }), 'zh')
  })

  it('detects English rules', () => {
    const text = 'Rule File: AGENTS.md\nWrite commit messages in English'
    assert.equal(detectRulesLanguage({ text, files: ['AGENTS.md'], truncated: false }), 'en')
  })

  it('defaults to English without rules', () => {
    assert.equal(detectRulesLanguage({ text: '', files: [], truncated: false }), 'en')
  })
})

describe('parseCommitMessage', () => {
  it('extracts the msg fence with the same regex as Trae', () => {
    assert.equal(parseCommitMessage('```msg\nfeat(api): add x\n```'), 'feat(api): add x')
    assert.equal(parseCommitMessage('前言\n```msg\r\nfix: y'), 'fix: y')
    assert.equal(MSG_FENCE.exec('```msg\nz')?.[1], 'z')
  })

  it('falls back to any fenced block, then to raw text', () => {
    assert.equal(parseCommitMessage('```text\nchore: z\n```'), 'chore: z')
    assert.equal(parseCommitMessage('  just text  '), 'just text')
  })

  it('strips stray backticks the same way Trae does', () => {
    assert.equal(parseCommitMessage('```msg\nfeat: a`b\n``'), 'feat: a`b')
  })
})

describe('prompts', () => {
  it('states the output protocol and the injection guard', () => {
    const zh = buildCommitSystemPrompt('zh')
    assert.ok(zh.includes('```msg'))
    assert.ok(zh.includes('Simplified Chinese'))
    assert.ok(zh.includes('不可信数据'))
    const en = buildCommitSystemPrompt('en')
    assert.ok(en.includes('untrusted DATA'))
  })

  it('frames the diff as JSON and truncates an overlong instruction', () => {
    const prompt = buildCommitUserPrompt({
      diff: '+a',
      rules: 'r',
      language: 'en',
      extraInstruction: 'z'.repeat(2_000),
    })
    const json = prompt.slice(prompt.indexOf('{'))
    const parsed = JSON.parse(json) as Record<string, string>
    assert.equal(parsed['diff'], '+a')
    assert.equal(parsed['rules'], 'r')
    assert.equal(parsed['extraInstruction']?.length, 1_000)
  })

  it('omits an empty extra instruction', () => {
    const prompt = buildCommitUserPrompt({ diff: '+a', rules: '', language: 'en', extraInstruction: '   ' })
    assert.ok(!prompt.includes('extraInstruction'))
  })
})

describe('resolveRoute', () => {
  const ctx = { get: () => undefined } as unknown as Context

  it('reads the agent route first', () => {
    const agent = { options: { provider: 'p', model: 'm' } } as unknown as Agent
    assert.deepEqual(resolveRoute(ctx, { agent, signal }), { provider: 'p', model: 'm' })
  })

  it('falls back to the session request header', () => {
    const agent = {
      options: {},
      session: { requestHeader: () => ({ config: { provider: 'h', model: 'hm' } }) },
    } as unknown as Agent
    assert.deepEqual(resolveRoute(ctx, { agent, signal }), { provider: 'h', model: 'hm' })
  })

  it('returns undefined without any source', () => {
    assert.equal(resolveRoute(ctx, { agent: undefined, signal }), undefined)
  })
})

describe('generateCommitMessage', () => {
  const noLlm = { get: () => undefined } as unknown as Context
  const withLlm = { get: (name: string) => (name === 'llm' ? {} : undefined) } as unknown as Context

  it('rejects an empty diff before touching the model', async () => {
    await assert.rejects(
      generateCommitMessage(noLlm, { agent: undefined, signal }, { diff: '  ', rules: '', language: 'en' }),
      /没有可用于生成提交信息的 diff/,
    )
  })

  it('reports a deployment without the llm service', async () => {
    await assert.rejects(
      generateCommitMessage(noLlm, { agent: undefined, signal }, { diff: '+a', rules: '', language: 'en' }),
      /没有挂载 llm 服务/,
    )
  })

  it('rejects when no model route can be resolved', async () => {
    await assert.rejects(
      generateCommitMessage(withLlm, { agent: undefined, signal }, { diff: '+a', rules: '', language: 'en' }),
      /无法确定模型路由/,
    )
  })
})

describe('runCommitMessage', () => {
  function deps(captured: CommitMessageInput[]): {
    runner: FakeRunner
    fs: FakeFs
    generate: (input: CommitMessageInput) => Promise<GenerateCommitMessageResult>
  } {
    const fs = new FakeFs()
    fs.files.set(join(WORKDIR, 'AGENTS.md'), '用中文写提交信息')
    const runner = new FakeRunner().on('diff', (argv) =>
      argv.includes('--name-only') ? ok(nameOnly(['a.ts'])) : ok('diff --git a/a.ts b/a.ts\n+x'),
    )
    return {
      runner,
      fs,
      generate: async (input) => {
        captured.push(input)
        return { message: 'feat(a): 新增 a', route: { provider: 'deepseek', model: 'deepseek-chat' } }
      },
    }
  }

  it('auto-detects Chinese from AGENTS.md and reports the run', async () => {
    const captured: CommitMessageInput[] = []
    const report = await runCommitMessage(deps(captured), { workdir: WORKDIR })
    assert.equal(report.language, 'zh')
    assert.equal(report.source, 'staged')
    assert.deepEqual(report.rulesFiles, ['AGENTS.md'])
    assert.equal(captured[0]?.language, 'zh')
    assert.ok(captured[0]?.diff.includes('+x'))
  })

  it('honours an explicit language override', async () => {
    const captured: CommitMessageInput[] = []
    const report = await runCommitMessage(deps(captured), { workdir: WORKDIR, language: 'en' })
    assert.equal(report.language, 'en')
    assert.equal(captured[0]?.language, 'en')
  })

  it('passes an extra instruction through', async () => {
    const captured: CommitMessageInput[] = []
    await runCommitMessage(deps(captured), { workdir: WORKDIR, extraInstruction: 'scope 用 api' })
    assert.equal(captured[0]?.extraInstruction, 'scope 用 api')
  })

  it('rejects a clean worktree', async () => {
    const runner = new FakeRunner().on('diff', ok('')).on('ls-files', ok(''))
    await assert.rejects(
      runCommitMessage(
        { runner, fs: new FakeFs(), generate: async () => ({ message: 'x', route: { provider: 'p', model: 'm' } }) },
        { workdir: WORKDIR },
      ),
      /都没有变更/,
    )
  })

  it('explains when every diff was dropped by the caps', async () => {
    const runner = new FakeRunner().on('diff', (argv) =>
      argv.includes('--name-only') ? ok(nameOnly(['a.ts'])) : ok('x'.repeat(60)),
    )
    await assert.rejects(
      runCommitMessage(
        { runner, fs: new FakeFs(), generate: async () => ({ message: 'x', route: { provider: 'p', model: 'm' } }) },
        { workdir: WORKDIR, singleDiffMaxLength: 10 },
      ),
      /超出 diff 长度上限/,
    )
  })
})

describe('formatCommitMessageReport', () => {
  it('renders the message, the provenance and the no-commit warning', () => {
    const text = formatCommitMessageReport({
      message: 'feat(a): x',
      route: { provider: 'deepseek', model: 'deepseek-chat' },
      language: 'zh',
      source: 'staged',
      fileCount: 2,
      candidateCount: 3,
      droppedSingle: 1,
      droppedTotal: 0,
      rulesFiles: ['AGENTS.md'],
      rulesTruncated: true,
    })
    assert.ok(text.includes('feat(a): x'))
    assert.ok(text.includes('deepseek / deepseek-chat'))
    assert.ok(text.includes('暂存区'))
    assert.ok(text.includes('AGENTS.md（已截断）'))
    assert.ok(text.includes('未暂存也未提交'))
    assert.ok(text.includes('超过单文件 diff 上限'))
  })

  it('says when no rule file was found', () => {
    const text = formatCommitMessageReport({
      message: 'chore: x',
      route: { provider: 'p', model: 'm' },
      language: 'en',
      source: 'worktree',
      fileCount: 1,
      candidateCount: 1,
      droppedSingle: 0,
      droppedTotal: 0,
      rulesFiles: [],
      rulesTruncated: false,
    })
    assert.ok(text.includes('未找到 AGENTS.md'))
    assert.ok(text.includes('工作区'))
  })
})
