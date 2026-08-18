const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error('分页参数必须是正整数');
  }
  return number;
}

export function parsePagination(query = {}) {
  const page = parsePositiveInteger(query.page, DEFAULT_PAGE);
  const pageSize = parsePositiveInteger(query.pageSize, DEFAULT_PAGE_SIZE);
  if (pageSize > MAX_PAGE_SIZE) {
    throw new Error(`pageSize 不能超过 ${MAX_PAGE_SIZE}`);
  }

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
  };
}

export function createPageResult(list, { page, pageSize, total = null, offset: _offset, ...extra }) {
  return {
    list,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: total === null ? null : Math.ceil(total / pageSize),
      ...extra,
    },
  };
}
