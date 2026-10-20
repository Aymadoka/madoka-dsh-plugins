import { collectCommitDiff } from './diff.js'
import type { CommitDiffOptions, DiffSource } from './diff.js'
import { collectProjectRules, detectRulesLanguage, RULES_MAX_LENGTH } from './rules.js'
import type { HarnessFs, CommandRunner } from './seams.js'
import type { CommitMessageInput, CommitMessageLanguage, GenerateCommitMessageResult } from './commitMessage.js'

/** 语言策略：auto 跟随项目规则文件的语言。 */
export type LanguagePolicy = 'auto' | CommitMessageLanguage

export interface CommitMessageOptions extends CommitDiffOptions {
  workdir: string
  language?: LanguagePolicy
  extraInstruction?: string
  rulesMaxLength?: number
}

export interface CommitMessageDeps {
  runner: CommandRunner
  fs: HarnessFs
  /** 注入点：生产实现直接调模型，测试替换为桩。 */
  generate: (input: CommitMessageInput) => Promise<GenerateCommitMessageResult>
}

export interface CommitMessageReport {
  message: string
  route: { provider: string; model: string }
  language: CommitMessageLanguage
  source: DiffSource
  fileCount: number
  candidateCount: number
  droppedSingle: number
  droppedTotal: number
  rulesFiles: string[]
  rulesTruncated: boolean
}

/** 收集 diff 与项目规则，判定语言，然后生成提交信息。不触碰任何 git 状态。 */
export async function runCommitMessage(
  deps: CommitMessageDeps,
  options: CommitMessageOptions,
): Promise<CommitMessageReport> {
  const diff = await collectCommitDiff(deps.runner, deps.fs, options.workdir, options)
  if (diff.diff.trim().length === 0) {
    throw new Error(
      diff.candidateCount === 0
        ? '工作区与暂存区都没有变更，无法生成提交信息。'
        : '所有变更都因超出 diff 长度上限被丢弃，无法生成提交信息。',
    )
  }

  const rules = await collectProjectRules(
    deps.fs,
    options.workdir,
    options.rulesMaxLength ?? RULES_MAX_LENGTH,
  )
  const policy = options.language ?? 'auto'
  const language: CommitMessageLanguage = policy === 'auto' ? detectRulesLanguage(rules) : policy

  const result = await deps.generate({
    diff: diff.diff,
    rules: rules.text,
    language,
    ...(options.extraInstruction === undefined ? {} : { extraInstruction: options.extraInstruction }),
  })

  return {
    message: result.message,
    route: result.route,
    language,
    source: diff.source,
    fileCount: diff.fileCount,
    candidateCount: diff.candidateCount,
    droppedSingle: diff.droppedSingle,
    droppedTotal: diff.droppedTotal,
    rulesFiles: rules.files,
    rulesTruncated: rules.truncated,
  }
}

const SOURCE_LABEL: Record<DiffSource, string> = {
  staged: '暂存区',
  worktree: '工作区（已跟踪改动 + 未跟踪文件）',
}

const LANGUAGE_LABEL: Record<CommitMessageLanguage, string> = {
  zh: '中文',
  en: '英文',
}

/** 格式化为可直接复制的中文报告。 */
export function formatCommitMessageReport(report: CommitMessageReport): string {
  const out: string[] = []
  out.push('## 生成的提交信息')
  out.push('')
  out.push('```text')
  out.push(report.message)
  out.push('```')
  out.push('')
  out.push('---')
  out.push(`- 来源: ${SOURCE_LABEL[report.source]}`)
  out.push(`- 文件: ${report.fileCount}/${report.candidateCount} 个纳入 diff`)
  out.push(`- 语言: ${LANGUAGE_LABEL[report.language]}`)
  out.push(`- 模型: ${report.route.provider} / ${report.route.model}`)
  if (report.rulesFiles.length > 0) {
    const truncated = report.rulesTruncated ? '（已截断）' : ''
    out.push(`- 项目规则: ${report.rulesFiles.join(', ')}${truncated}`)
  } else {
    out.push('- 项目规则: 未找到 AGENTS.md，按 Conventional Commits 兜底')
  }
  if (report.droppedSingle > 0) out.push(`- 丢弃: ${report.droppedSingle} 个文件超过单文件 diff 上限`)
  if (report.droppedTotal > 0) out.push(`- 丢弃: ${report.droppedTotal} 个文件超过 diff 总量上限`)
  out.push('')
  out.push('💡 仅生成文本，未暂存也未提交。确认后请调用 git_stage 与 git_commit 完成本地提交。')
  return out.join('\n')
}
