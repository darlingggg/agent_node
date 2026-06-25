import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
const decoder = new TextDecoder('gbk')


const execCommand = async (command) => {
  try {
    const { stdout, stderr,code } = await execAsync(command, {
      cwd: 'C:\\pro_self\\agentNode',
      encoding: 'buffer',
    })
    return { stdout: decoder.decode(stdout), stderr: decoder.decode(stderr) }
  }
  catch (error) {
    return {code: error.code, stderr: decoder.decode(error.stderr || '')}
  }
}

execCommand('dir')