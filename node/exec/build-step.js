export function formatDuration(milliseconds) {
  if (milliseconds < 1000) return `${milliseconds}ms`;
  if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(1)}s`;
  const minutes = Math.floor(milliseconds / 60000);
  const seconds = Math.round((milliseconds % 60000) / 1000);
  return `${minutes}m${seconds}s`;
}

export function trimOutput(text, maxLength = 2000) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `...(省略 ${text.length - maxLength} 字符)\n${text.slice(-maxLength)}`;
}

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
      : (result.stderr || result.stdout || '未知错误');
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
      },
    });
    send({ event: 'text', data: `✗ ${title}失败（${durationText}）\n${trimOutput(errorMessage, 500)}` });
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
  };
  send({ event: 'step', data: step });
  send({ event: 'text', data: `✓ ${title}完成（耗时 ${durationText}）` });
  return { ...result, step };
}
