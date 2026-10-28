/** 将毫秒耗时转换成日志和界面使用的 ms、s 或 m+s 文本。 */
export function formatDuration(milliseconds) {
  if (milliseconds < 1000) return `${milliseconds}ms`;
  if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(1)}s`;
  const minutes = Math.floor(milliseconds / 60000);
  const seconds = Math.round((milliseconds % 60000) / 1000);
  return `${minutes}m${seconds}s`;
}

/** 限制持久化/展示的日志长度，保留更可能包含报错原因的尾部；不是子进程输出缓冲上限。 */
export function trimOutput(text, maxLength = 2000) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `...(省略 ${text.length - maxLength} 字符)\n${text.slice(-maxLength)}`;
}

/**
 * 包装单个安装/构建/部署步骤：发送开始事件，调用 execute，再发送完成或失败事件。
 * key 是阶段标识，command 是展示文本，execute 返回 process-runner 的命令结果。
 * send 来自 scheduler，用于更新任务阶段和通知订阅者；失败抛错使后续步骤停止。
 * 成功返回原命令结果及 step 摘要，供 pipeline 汇总。
 */
export async function runBuildStep({ key, title, command, execute, send }) {
  const startedAt = Date.now();
  send({
    event: 'step',
    data: { key, title, status: 'running', command, message: `正在${title}...` },
  });
  send({ event: 'text', data: `▶ ${title}：正在执行 ${command}` });

  const result = await execute();
  const duration = Date.now() - startedAt;
  const durationText = formatDuration(duration);
  if (!result.success) {
    const errorMessage = result.timedOut
      ? `${title}执行超时，已终止相关子进程`
      : result.stderr || result.stdout || '未知错误';
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
        code: result.code,
        signal: result.signal,
        resources: result.resources,
      },
    });
    send({
      event: 'text',
      data: `✗ ${title}失败（${durationText}）\n${trimOutput(errorMessage, 500)}`,
    });
    throw new Error(`【${title}】失败: ${errorMessage}`);
  }

  const step = {
    key,
    title,
    status: 'done',
    command,
    duration,
    durationText,
    message: `${title}完成`,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr),
    resources: result.resources,
  };
  send({ event: 'step', data: step });
  send({ event: 'text', data: `✓ ${title}完成（耗时 ${durationText}）` });
  return { ...result, step };
}
