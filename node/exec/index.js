import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs/promises'
import path from 'path'
import { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN } from '../../key.js'

const execAsync = promisify(exec)

/**
 * 将命令输出的 Buffer 解码为字符串
 * @param {Buffer} buffer 原始字节
 * @param {string} encoding 编码格式，Node 工具用 utf-8，Windows cmd 用 gbk
 */
const decodeOutput = (buffer, encoding = 'utf-8') => {
  if (!buffer?.length) return ''
  return new TextDecoder(encoding).decode(buffer)
}

/**
 * 执行 shell 命令
 * @param {string} command 命令
 * @param {string} projectPath 工作目录
 * @param {string} encoding 输出编码，默认 utf-8
 */
const execCommand = async (command, projectPath, encoding = 'utf-8') => {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: projectPath,
      encoding: 'buffer',
    })
    return {
      success: true,
      code: 0,
      stdout: decodeOutput(stdout, encoding),
      stderr: decodeOutput(stderr, encoding),
    }
  } catch (error) {
    return {
      success: false,
      code: error.code,
      stdout: decodeOutput(error.stdout, encoding),
      stderr: decodeOutput(error.stderr, encoding),
    }
  }
}

/** Cloudflare Pages 项目名称 */
const CF_PROJECT_NAME = 'gen-agent'

/**
 * 格式化耗时，便于前端展示
 * @param {number} ms 毫秒
 * @returns {string}
 */
const formatDuration = (ms) => {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60000)
  const sec = Math.round((ms % 60000) / 1000)
  return `${min}m${sec}s`
}

/**
 * 从 wrangler 输出中提取部署 URL
 * @param {string} output 命令输出
 * @returns {string|null}
 */
const extractDeployUrl = (output) => {
  const match = output.match(/https:\/\/[^\s]+\.pages\.dev/)
  return match ? match[0] : null
}

/**
 * 根据部署 URL 从 deployment list JSON 中匹配部署 ID
 * @param {string} listOutput wrangler pages deployment list --json 输出
 * @param {string} link 部署访问链接
 * @returns {string|null}
 */
const extractDeploymentIdByLink = (listOutput, link) => {
  if (!listOutput || !link) return null

  try {
    const deployments = JSON.parse(listOutput)
    if (!Array.isArray(deployments)) return null

    const normalizedLink = link.replace(/\/$/, '')
    const matched = deployments.find((item) => {
      const deploymentUrl = (item.Deployment || item.deployment || '').replace(/\/$/, '')
      return deploymentUrl === normalizedLink
    })

    return matched?.Id || matched?.id || null
  } catch {
    return null
  }
}

/**
 * 截取命令输出末尾，避免 done 载荷过大
 * @param {string} text 原始输出
 * @param {number} maxLen 最大长度
 * @returns {string}
 */
const trimOutput = (text, maxLen = 2000) => {
  if (!text) return ''
  if (text.length <= maxLen) return text
  return `...(省略 ${text.length - maxLen} 字符)\n${text.slice(-maxLen)}`
}

/**
 * 执行单个构建步骤并通过 SSE 推送进度
 * @param {object} options 步骤配置
 * @param {string} options.key 步骤标识
 * @param {string} options.title 步骤标题
 * @param {string} options.command 执行命令
 * @param {string} options.projectPath 项目路径
 * @param {Function} options.send SSE 推送函数
 * @returns {Promise<object>} 步骤执行结果
 */
const runBuildStep = async ({ key, title, command, projectPath, send }) => {
  const startAt = Date.now()

  send({
    event: 'step',
    data: {
      key,
      title,
      status: 'running',
      command,
      message: `正在${title}...`,
    },
  })
  send({ event: 'text', data: `▶ ${title}：正在执行 ${command}` })

  const execRes = await execCommand(command, projectPath)
  const duration = Date.now() - startAt
  const durationText = formatDuration(duration)

  if (!execRes.success) {
    const errorMessage = execRes.stderr || execRes.stdout || '未知错误'
    send({
      event: 'step',
      data: {
        key,
        title,
        status: 'error',
        command,
        duration,
        durationText,
        message: `${title}失败`,
        error: trimOutput(errorMessage, 1000),
        code: execRes.code,
      },
    })
    send({ event: 'text', data: `✗ ${title}失败（${durationText}）\n${trimOutput(errorMessage, 500)}` })
    throw new Error(`【${title}】失败: ${errorMessage}`)
  }

  const stepInfo = {
    key,
    title,
    status: 'done',
    command,
    duration,
    durationText,
    message: `${title}完成`,
    stdout: trimOutput(execRes.stdout),
    stderr: trimOutput(execRes.stderr),
  }

  send({ event: 'step', data: stepInfo })
  send({ event: 'text', data: `✓ ${title}完成（耗时 ${durationText}）` })

  return { ...execRes, step: stepInfo }
}

/** 返回当前构建机需要的 Rolldown 原生包名；其他平台交给 pnpm 正常处理。 */
const getRolldownBindingName = () => {
  if (process.platform !== 'linux') return null
  if (process.arch !== 'x64' && process.arch !== 'arm64') return null
  const isGlibc = Boolean(process.report?.getReport?.().header?.glibcVersionRuntime)
  return `@rolldown/binding-linux-${process.arch}-${isGlibc ? 'gnu' : 'musl'}`
}

/**
 * 从已安装的 Rolldown 清单读取与主包严格匹配的原生包版本。
 * pnpm 的虚拟存储目录可能包含多个版本，因此逐个读取 package.json，优先返回声明了当前平台包的版本。
 */
const findRolldownBinding = async (projectPath) => {
  const bindingName = getRolldownBindingName()
  if (!bindingName) return null

  const virtualStoreDir = path.join(projectPath, 'node_modules', '.pnpm')
  let entries
  try {
    entries = await fs.readdir(virtualStoreDir, { withFileTypes: true })
  } catch {
    return null
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('rolldown@')) continue
    const rolldownDir = path.join(virtualStoreDir, entry.name, 'node_modules', 'rolldown')
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(rolldownDir, 'package.json'), 'utf-8'))
      const version = pkg.optionalDependencies?.[bindingName]
      if (!version) continue

      const bindingPath = path.join(
        virtualStoreDir,
        entry.name,
        'node_modules',
        ...bindingName.split('/'),
        'package.json'
      )
      const installed = await fs.access(bindingPath).then(() => true, () => false)
      return { bindingName, version, installed }
    } catch {
      // Ignore unrelated or incomplete virtual-store entries.
    }
  }
  return null
}

/**
 * pnpm 偶尔会静默跳过 Rolldown 的间接 optionalDependency。
 * 临时把匹配的原生包作为直接开发依赖安装，安装后恢复清单，避免 Linux 依赖污染 WebContainer 模板。
 */
const ensureRolldownBinding = async (projectPath, send) => {
  const binding = await findRolldownBinding(projectPath)
  if (!binding || binding.installed) return null

  const packagePath = path.join(projectPath, 'package.json')
  const lockPath = path.join(projectPath, 'pnpm-lock.yaml')
  const originalPackage = await fs.readFile(packagePath)
  const originalLock = await fs.readFile(lockPath).catch(() => null)

  try {
    return await runBuildStep({
      key: 'native-binding',
      title: '修复原生依赖',
      command: `pnpm add --save-dev --save-exact ${binding.bindingName}@${binding.version} --config.confirmModulesPurge=false`,
      projectPath,
      send,
    })
  } finally {
    await fs.writeFile(packagePath, originalPackage)
    if (originalLock) await fs.writeFile(lockPath, originalLock)
  }
}

/**
 * 构建期间为 pnpm 11 提供最小依赖脚本白名单。
 * 生成项目都是单包项目；构建完成后恢复原文件，避免覆盖用户配置。
 */
const applyTemporaryPnpmBuildPolicy = async (projectPath) => {
  const workspacePath = path.join(projectPath, 'pnpm-workspace.yaml')
  const original = await fs.readFile(workspacePath).catch(() => null)
  const originalText = original?.toString('utf-8') || ''
  const nodeLinker = originalText.match(/^\s*nodeLinker:\s*([^\s#]+)/m)?.[1]
  const policyLines = [
    'packages:',
    "  - '.'",
  ]
  if (nodeLinker) policyLines.push(`nodeLinker: ${nodeLinker}`)
  policyLines.push(
    'allowBuilds:',
    '  esbuild: true',
    '',
  )
  await fs.writeFile(workspacePath, policyLines.join('\n'), 'utf-8')

  return async () => {
    if (original) await fs.writeFile(workspacePath, original)
    else await fs.rm(workspacePath, { force: true })
  }
}

/**
 * 构建项目并部署到 Cloudflare Pages
 * @param {string} projectPath 项目路径
 * @param {Function} [send] SSE 推送函数
 * @returns {Promise<object>} 构建部署结果
 */
export const buildCommand = async (projectPath, send = () => {}) => {
  process.env.CLOUDFLARE_API_TOKEN = CLOUDFLARE_API_TOKEN
  process.env.CLOUDFLARE_ACCOUNT_ID = CLOUDFLARE_ACCOUNT_ID

  const startedAt = Date.now()
  const distPath = path.join(projectPath, 'dist')
  const deployCommand = `npx wrangler pages deploy ${distPath} --project-name=${CF_PROJECT_NAME}`
  const getDeploymentIdCommand = `npx wrangler pages deployment list --project-name=${CF_PROJECT_NAME} --json`

  send({
    event: 'step',
    data: {
      key: 'prepare',
      title: '准备构建',
      status: 'running',
      message: '正在初始化构建环境...',
      projectPath,
      projectName: CF_PROJECT_NAME,
    },
  })

  const restorePnpmBuildPolicy = await applyTemporaryPnpmBuildPolicy(projectPath)
  let installRes
  let nativeBindingRes
  let buildRes
  try {
    installRes = await runBuildStep({
      key: 'install',
      title: '安装依赖',
      command: 'pnpm install --config.optional=true --config.confirmModulesPurge=false',
      projectPath,
      send,
    })

    nativeBindingRes = await ensureRolldownBinding(projectPath, send)

    buildRes = await runBuildStep({
      key: 'build',
      title: '构建项目',
      command: 'pnpm build',
      projectPath,
      send,
    })
  } finally {
    await restorePnpmBuildPolicy()
  }

  const uploadRes = await runBuildStep({
    key: 'deploy',
    title: '部署上线',
    command: deployCommand,
    projectPath,
    send,
  })

  const link = extractDeployUrl(uploadRes.stdout)

  // 通过 deployment list 命令，根据 link 匹配 Cloudflare 部署 ID
  let deploymentId = null
  if (link) {
    const getDeploymentIdRes = await execCommand(getDeploymentIdCommand, projectPath)
    if (getDeploymentIdRes.success) {
      deploymentId = extractDeploymentIdByLink(getDeploymentIdRes.stdout, link)
    }
  }
  const totalDuration = Date.now() - startedAt
  const completedAt = new Date().toISOString()

  const steps = [installRes.step, nativeBindingRes?.step, buildRes.step, uploadRes.step].filter(Boolean)
  const result = {
    success: true,
    code: 0,
    summary: link
      ? `部署成功，项目已上线（总耗时 ${formatDuration(totalDuration)}）`
      : `部署命令已执行，但未解析到访问链接（总耗时 ${formatDuration(totalDuration)}）`,
    link,
    deploymentId,
    projectName: CF_PROJECT_NAME,
    projectPath,
    distPath,
    completedAt,
    duration: totalDuration,
    durationText: formatDuration(totalDuration),
    steps,
    deploy: {
      url: link,
      deploymentId,
      projectName: CF_PROJECT_NAME,
      stdout: trimOutput(uploadRes.stdout),
      stderr: trimOutput(uploadRes.stderr),
    },
  }

  send({ event: 'done', data: result })
  return result
}

/**
 * 删除 Cloudflare Pages 线上部署版本
 * @param {string} projectPath 项目路径
 * @param {string} deploymentId 部署 ID
 * @returns {Promise<object>} 命令执行结果
 */
export const deleteOnlineVersion = async (projectPath, deploymentId) => {
  process.env.CLOUDFLARE_API_TOKEN = CLOUDFLARE_API_TOKEN
  process.env.CLOUDFLARE_ACCOUNT_ID = CLOUDFLARE_ACCOUNT_ID

  // --force 跳过交互确认，非交互环境下默认会选 no 导致删除失败
  const deleteCommand = `npx wrangler pages deployment delete ${deploymentId} --project-name=${CF_PROJECT_NAME} --force`
  const res = await execCommand(deleteCommand, projectPath)
  return res
}
// const res = await execCommand('npx wrangler pages deployment list --project-name=gen-agent --json',"C:/ai/copyPro/projecth4nf66jip1g_1781703763151")
// console.log(res.stdout,typeof res.stdout)
// const deploymentId = JSON.parse(res.stdout).filter(item => item.Deployment === "https://86eb13b4.gen-agent.pages.dev")
// console.log(deploymentId)
// 删除部署
// npx wrangler pages deployment delete <deployment-id> --project-name=<你的项目名>
// 获取部署Id
// npx wrangler pages deployment list --project-name=gen-agent --json
