import { exec } from 'child_process'
import { promisify } from 'util'
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

/**
 * 
 * @param {string} output 输出结果
 * @returns {string} 部署URL
 */
const extractDeployUrl = (output) => {
  const match = output.match(/https:\/\/[^\s]+\.pages\.dev/)
  return match ? match[0] : null
}

/**
 * 构建项目并部署到 Cloudflare Pages
 * @param {string} projectPath 项目路径
 */
export const buildCommand = async (projectPath,send=()=>{}) => {
  process.env.CLOUDFLARE_API_TOKEN = CLOUDFLARE_API_TOKEN
  process.env.CLOUDFLARE_ACCOUNT_ID = CLOUDFLARE_ACCOUNT_ID

  send({event: 'text', data: '开始安装依赖...'})
  const res = await execCommand('pnpm install', projectPath)
  if (!res.success) throw new Error(res.stderr)
  send({event: 'text', data: '依赖安装完成'})

  send({event: 'text', data: '开始构建...'})
  const buildRes = await execCommand('pnpm build', projectPath)
  if (!buildRes.success) throw new Error(buildRes.stderr)
  send({event: 'text', data: '构建完成'})

  send({event: 'text', data: '开始部署...'})
  const distPath = path.join(projectPath, 'dist')
  const uploadRes = await execCommand(
    `npx wrangler pages deploy ${distPath} --project-name=gen-agent`,
    projectPath
  )
  if (!uploadRes.success) throw new Error(uploadRes.stderr)
  send({event: 'text', data: '部署完成'})

  send({event:'done',data:JSON.stringify({ success: true, code: 0, stdout: uploadRes.stdout, stderr: uploadRes.stderr,link: extractDeployUrl(uploadRes.stdout) })})
}


// 删除部署
// npx wrangler pages deployment delete <deployment-id> --project-name=<你的项目名>
// 获取部署Id
// npx wrangler pages deployment list --project-name=gen-agent --json