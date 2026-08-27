const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function pad(value) {
  return String(value).padStart(2, '0');
}

/** 返回指定时刻对应的北京时间自然日 YYYY-MM-DD。 */
export function getBeijingDateKey(date = new Date()) {
  return new Date(date.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/** 返回包含今天在内的北京时间统计范围，以及对应 UTC 查询边界。 */
export function getBeijingDateRange(days, now = new Date()) {
  const endDate = getBeijingDateKey(now);
  const endParts = endDate.split('-').map(Number);
  const endBeijingMidnightUtc = Date.UTC(endParts[0], endParts[1] - 1, endParts[2]) - BEIJING_OFFSET_MS;
  const startUtc = new Date(endBeijingMidnightUtc - (days - 1) * 24 * 60 * 60 * 1000);
  const endExclusiveUtc = new Date(endBeijingMidnightUtc + 24 * 60 * 60 * 1000);

  return {
    startDate: getBeijingDateKey(startUtc),
    endDate,
    startUtc: formatUtcSqlDate(startUtc),
    endExclusiveUtc: formatUtcSqlDate(endExclusiveUtc),
    startEpochSeconds: Math.floor(startUtc.getTime() / 1000),
    endExclusiveEpochSeconds: Math.floor(endExclusiveUtc.getTime() / 1000),
  };
}

/** 生成范围内所有北京时间日期，用于补齐无数据日期。 */
export function listBeijingDates(startDate, days) {
  const [year, month, day] = startDate.split('-').map(Number);
  const start = Date.UTC(year, month - 1, day);
  return Array.from({ length: days }, (_, index) => (
    new Date(start + index * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  ));
}

function formatUtcSqlDate(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}
