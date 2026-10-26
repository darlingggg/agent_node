-- 工具过程增量迁移；可重复执行，不改已有消息/图片表。
CREATE TABLE IF NOT EXISTS message_tool_calls (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  message_id INT NOT NULL,
  assistant_session_id INT NOT NULL,
  project_id INT NOT NULL,
  conversation_id BIGINT NOT NULL,
  account VARCHAR(50) NOT NULL,
  tool_call_id VARCHAR(191) NOT NULL,
  name VARCHAR(100) NOT NULL,
  sequence_no INT NOT NULL,
  text_offset INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  args_json JSON NULL,
  result_json JSON NULL,
  error_text MEDIUMTEXT NULL,
  started_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3) NULL,
  duration_ms BIGINT NULL,
  UNIQUE KEY uk_message_tool_call (message_id, tool_call_id),
  INDEX idx_tool_calls_owner_message (account, message_id, sequence_no),
  INDEX idx_tool_calls_conversation (account, conversation_id)
) COMMENT '消息工具调用过程：查看历史不重新执行工具';
