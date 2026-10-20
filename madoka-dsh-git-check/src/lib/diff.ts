import { resolve } from 'node:path'
import type { CommandRunner, HarnessFs } from './seams.js'

/** 单个文件 diff 的字符上限，超过即整份丢弃（对齐 Trae 的 singleDiffMaxLength）。 */
export const SINGLE_DIFF_MAX_LENGTH = 50_000

/** 送入模型的 diff 总字符上限（对齐 Trae 的 diffMaxLength）。 */
export const DIFF_MAX_LENGTH = 500_000

/** 未跟踪文件合成 patch 前允许读取的最大字节数，更大的文件直接跳过。 */
export const MAX_UNTRACKED_FILE_BYTES = 256 * 1024

/** 取 diff 的来源：暂存区优先，否则工作区。 */
export type DiffSource = 'staged' | 'worktree'

export interface CommitDiffOptions {
  singleDiffMaxLength?: number
  diffMaxLength?: number
  maxUntrackedFileBytes?: number
}

export interface CommitDiff {
  /** 拼接后的统一 diff 文本；没有可送出的变更时为空串。 */
  diff: string
  source: DiffSource
  /** 实际纳入 diff 的文件数。 */
  fileCount: number
  /** 候选文件总数，含被上限丢弃的。 */
  candidateCount: number
  /** 因超过单文件上限被丢弃的文件数。 */
  droppedSingle: number
  /** 因超过总量上限被丢弃的文件数。 */
  droppedTotal: number
}

/** 按 NUL 切分 `git -z` 输出：路径原样保留，不做引号解析。 */
export function splitNulPaths(output: string): string[] {
  return output
    .split('\0')
    .map((entry) => (entry.endsWith('\r') ? entry.slice(0, -1) : entry))
    .filter((entry) => entry.length > 0)
}

async function listPaths(
  runner: CommandRunner,
  workdir: string,
  argv: readonly string[],
): Promise<string[]> {
  try {
    const res = await runner.run(argv, { cwd: workdir })
    if (res.exitCode !== 0) return []
    return splitNulPaths(res.stdout)
  } catch {
    return []
  }
}

async function readTrackedDiff(
  runner: CommandRunner,
  workdir: string,
  source: DiffSource,
  path: string,
): Promise<string | undefined> {
  const argv = source === 'staged'
    ? ['git', 'diff', '--cached', 'HEAD', '--', path]
    : ['git', 'diff', 'HEAD', '--', path]
  try {
    const res = await runner.run(argv, { cwd: workdir })
    if (res.exitCode !== 0) return undefined
    return res.stdout
  } catch {
    return undefined
  }
}

/**
 * 为未跟踪文件合成 patch：Trae 只吐 hunk 头与 `+` 行，
 * 这里补上 `diff --git` / `+++` 头，让模型能看出改动属于哪个文件。
 * 行数按实际行数计（Trae 用字节长度，对非 ASCII 文件会算错）。
 */
export async function buildUntrackedPatch(
  fs: HarnessFs,
  workdir: string,
  path: string,
  maxBytes: number,
): Promise<string | undefined> {
  let content: string | undefined
  try {
    content = await fs.readFileIfPresent(resolve(workdir, path))
  } catch {
    return undefined
  }
  if (content === undefined) return undefined
  if (Buffer.byteLength(content, 'utf8') > maxBytes) return undefined
  // NUL 字节视为二进制，不合成 patch。
  if (content.includes('\0')) return undefined

  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const body = lines.map((line) => `+${line}`).join('\n')

  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
  ].join('\n')
}

/**
 * 收集待生成提交信息的 diff：暂存区非空就只取暂存区，否则取「已跟踪改动 + 未跟踪文件」。
 * 单文件超过 `singleDiffMaxLength` 直接丢弃；剩余按长度升序累加，总量不超过 `diffMaxLength`。
 */
export async function collectCommitDiff(
  runner: CommandRunner,
  fs: HarnessFs,
  workdir: string,
  options: CommitDiffOptions = {},
): Promise<CommitDiff> {
  const singleMax = options.singleDiffMaxLength ?? SINGLE_DIFF_MAX_LENGTH
  const totalMax = options.diffMaxLength ?? DIFF_MAX_LENGTH
  const maxUntrackedBytes = options.maxUntrackedFileBytes ?? MAX_UNTRACKED_FILE_BYTES

  const staged = await listPaths(runner, workdir, ['git', 'diff', '--cached', '--name-only', '-z'])
  const source: DiffSource = staged.length > 0 ? 'staged' : 'worktree'

  const tracked = source === 'staged'
    ? staged
    : await listPaths(runner, workdir, ['git', 'diff', '--name-only', '-z', 'HEAD'])
  const untracked = source === 'staged'
    ? []
    : await listPaths(runner, workdir, ['git', 'ls-files', '--others', '--exclude-standard', '-z'])
  const untrackedSet = new Set(untracked)

  const candidates = [...new Set([...tracked, ...untracked])]
  const patches: string[] = []
  let droppedSingle = 0

  for (const path of candidates) {
    const patch = untrackedSet.has(path)
      ? await buildUntrackedPatch(fs, workdir, path, maxUntrackedBytes)
      : await readTrackedDiff(runner, workdir, source, path)
    if (patch === undefined || patch.length === 0) continue
    if (patch.length > singleMax) {
      droppedSingle += 1
      continue
    }
    patches.push(patch)
  }

  patches.sort((a, b) => a.length - b.length)

  const selected: string[] = []
  let total = 0
  let droppedTotal = 0
  for (const patch of patches) {
    const next = total + patch.length + (selected.length > 0 ? 1 : 0)
    if (next > totalMax) {
      droppedTotal = patches.length - selected.length
      break
    }
    selected.push(patch)
    total = next
  }

  return {
    diff: selected.join('\n'),
    source,
    fileCount: selected.length,
    candidateCount: candidates.length,
    droppedSingle,
    droppedTotal,
  }
}
