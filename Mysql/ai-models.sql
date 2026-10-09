-- 模型目录与会话配置；已有 ai_models 时保留记录并扩展字段长度。
CREATE TABLE IF NOT EXISTS ai_models (
  id INT PRIMARY KEY AUTO_INCREMENT NOT NULL COMMENT '主键id',
  model_key VARCHAR(128) NOT NULL UNIQUE COMMENT '模型标识',
  model_name VARCHAR(128) NOT NULL COMMENT '模型名称',
  capabilities JSON NULL COMMENT '模型能力及上下文限制',
  effort JSON NULL COMMENT '支持的推理强度及默认值',
  enabled TINYINT NOT NULL DEFAULT 1 COMMENT '是否启用 0:否 1:是',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间'
) COMMENT '模型表';

ALTER TABLE ai_models
  MODIFY COLUMN model_key VARCHAR(128) NOT NULL COMMENT '模型标识',
  MODIFY COLUMN model_name VARCHAR(128) NOT NULL COMMENT '模型名称';

ALTER TABLE ai_models
  ADD COLUMN is_default TINYINT NOT NULL DEFAULT 0 COMMENT '是否默认模型',
  ADD COLUMN default_slot TINYINT GENERATED ALWAYS AS (IF(is_default = 1, 1, NULL)) VIRTUAL UNIQUE COMMENT '保证最多一个默认模型';

ALTER TABLE ai_models
  ADD COLUMN manual_disabled TINYINT NOT NULL DEFAULT 0 COMMENT '管理员人工禁用，不受同步覆盖',
  ADD COLUMN provider_available TINYINT NOT NULL DEFAULT 1 COMMENT '服务商目录是否仍提供模型';

UPDATE ai_models SET provider_available = enabled WHERE manual_disabled = 0;

-- 以下 ADD COLUMN 只在字段不存在时执行；migrate-ai-models.js 会检查后执行，可重复运行。
ALTER TABLE conversations
  ADD COLUMN model VARCHAR(128) NULL COMMENT '当前选择的模型标识',
  ADD COLUMN reasoning_effort VARCHAR(32) NULL COMMENT '当前选择的推理强度';

ALTER TABLE sessions
  ADD COLUMN model VARCHAR(128) NULL COMMENT '本轮实际使用的模型标识',
  ADD COLUMN reasoning_effort VARCHAR(32) NULL COMMENT '本轮实际使用的推理强度';

-- 历史调用使用原固定模型；历史强度未配置，保留 NULL。
UPDATE conversations SET model = 'deepseek-v4-pro' WHERE model IS NULL;
UPDATE sessions SET model = 'deepseek-v4-pro' WHERE model IS NULL AND role = 'assistant';
