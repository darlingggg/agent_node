CREATE TABLE IF NOT EXISTS project_build_tasks (
  id CHAR(36) PRIMARY KEY COMMENT '构建任务唯一标识（UUID）',
  project_id INT NOT NULL COMMENT '所属项目 ID',
  account VARCHAR(52) NOT NULL COMMENT '项目所属账号',
  kind VARCHAR(16) NOT NULL COMMENT '任务类型：preview 兼容预览，publish 正式发布',
  revision CHAR(64) NOT NULL COMMENT '项目源码内容指纹（SHA-256，64 位十六进制字符串）',
  status VARCHAR(16) NOT NULL COMMENT '任务状态：queued 排队中，running 执行中，ready 成功，failed 失败，superseded 已被替代',
  requested_at BIGINT NOT NULL COMMENT '最近请求顺序值（基于毫秒时间戳，单调递增，复用或替换任务时更新）',
  completed_at VARCHAR(32) DEFAULT NULL COMMENT '任务结束时间（ISO 8601 格式，未结束时为空）',
  payload JSON NOT NULL COMMENT '完整任务状态，包含阶段、错误、构建结果和相关时间等信息',
  INDEX idx_build_project (project_id, kind, requested_at) COMMENT '按项目和任务类型查询最近请求',
  INDEX idx_build_revision (project_id, kind, revision, status) COMMENT '按项目、任务类型、源码指纹和状态查找可复用结果'
) COMMENT = '项目兼容预览与正式发布构建任务表';
