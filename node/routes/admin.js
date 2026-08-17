import express from 'express';

/**
 * 后台接口路由。
 *
 * 后台业务接口按模块继续拆分后，在这里统一挂载，例如：
 * router.use('/users', userAdminRouter);
 */
const router = express.Router();

export default router;
