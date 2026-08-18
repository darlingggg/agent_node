import express from 'express';
import authJWT from '../middleware/authJWT.js';
import { requireAdmin } from '../middleware/adminAuth.js';
import projectsRouter from './admin/projects.js';
import usersRouter from './admin/users.js';
import assetsRouter from './admin/assets.js';
import dashboardRouter from './admin/dashboard.js';

/**
 * 后台接口路由。
 *
 * 所有在鉴权中间件之后挂载的后台模块都会统一校验管理权限。
 */
const router = express.Router();

router.use(authJWT, requireAdmin);
router.use('/projects', projectsRouter);
router.use('/users', usersRouter);
router.use('/assets', assetsRouter);
router.use('/dashboard', dashboardRouter);

export default router;
