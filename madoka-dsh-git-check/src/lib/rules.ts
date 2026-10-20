import { join } from 'node:path'
import type { HarnessFs } from './seams.js'

/** 项目规则文本的字符上限（对齐 Trae 的 gitMessageRulesMaxLength）。 */
export const RULES_MAX_LENGTH = 5_000

/** 被截断时补在末尾的标记（与 Trae 同款）。 */
export const RULES_TRUNCATION_MARK = '[...]'

/** 规则文件候选，相对仓库根，按优先级排列。 */
export const RULES_FILES: readonly string[] = ['AGENTS.md']

export interface ProjectRules {
  /** 拼好的规则文本；没有规则文件时为空串。 */
  text: string
  /** 实际读入的规则文件（相对路径）。 */
  files: string[]
  /** 是否因超出上限被截断。 */
  truncated: boolean
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u

/**
 * 读取项目规则：与 Trae 相同的 `Rule File: <path>\n<content>\n\n` 拼装与截断语义，
 * 规则来源换成 DSH 约定的仓库根 `AGENTS.md`。
 */
export async function collectProjectRules(
  fs: HarnessFs,
  workdir: string,
  maxLength: number = RULES_MAX_LENGTH,
): Promise<ProjectRules> {
  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    return { text: '', files: [], truncated: false }
  }

  const parts: string[] = []
  const used: string[] = []
  let total = 0
  let truncated = false

  for (const name of RULES_FILES) {
    let content: string | undefined
    try {
      content = await fs.readFileIfPresent(join(workdir, name))
    } catch {
      content = undefined
    }
    if (content === undefined) continue
    const body = content.trim()
    if (body.length === 0) continue

    const block = `Rule File: ${name}\n${body}\n\n`
    const remaining = maxLength - total
    if (remaining <= 0) {
      truncated = true
      break
    }
    if (block.length > remaining) {
      parts.push(block.slice(0, remaining))
      used.push(name)
      total = maxLength
      truncated = true
      break
    }
    parts.push(block)
    used.push(name)
    total += block.length
  }

  if (parts.length === 0) return { text: '', files: [], truncated: false }

  let text = parts.join('').trimEnd()
  if (truncated) {
    const mark = `\n${RULES_TRUNCATION_MARK}`
    const keep = Math.max(0, maxLength - mark.length)
    text = `${text.slice(0, keep)}${mark}`
  }

  return { text: text.trim(), files: used, truncated }
}

/**
 * 由规则文本判定提交信息语言：中日韩字符占比达到 10% 即视为中文语境。
 * 先剔除 `Rule File:` 头，避免 ASCII 前缀稀释占比。
 * 没有规则文本时返回英文——这是唯一可预测且无需额外服务的判据。
 */
export function detectRulesLanguage(rules: ProjectRules): 'zh' | 'en' {
  const body = rules.text
    .split('\n')
    .filter((line) => !line.startsWith('Rule File: '))
    .join('\n')

  let cjk = 0
  let visible = 0
  for (const ch of body) {
    if (/\s/u.test(ch)) continue
    visible += 1
    if (CJK.test(ch)) cjk += 1
  }
  if (visible === 0) return 'en'
  return cjk / visible >= 0.1 ? 'zh' : 'en'
}
