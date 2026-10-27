CREATE TABLE IF NOT EXISTS project_build_tasks (
  id CHAR(36) PRIMARY KEY,
  project_id INT NOT NULL,
  account VARCHAR(52) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  revision CHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  requested_at BIGINT NOT NULL,
  completed_at VARCHAR(32) DEFAULT NULL,
  payload JSON NOT NULL,
  INDEX idx_build_project (project_id, kind, requested_at),
  INDEX idx_build_revision (project_id, kind, revision, status)
);
