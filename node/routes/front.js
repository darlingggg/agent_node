import express from 'express';
import modelsRouter from './front/models.js';
import systemRouter from './front/system.js';
import authRouter from './front/auth.js';
import fileRouter from './front/files.js';
import projectRouter from './front/projects.js';
import sessionRouter from './front/sessions.js';
import chatRouter from './front/chat.js';
import imageGenerationRouter from './front/image-generation.js';
import activityRouter from './front/activity.js';
import deploymentRouter from './front/deployment.js';

const router = express.Router();

router.use(
  modelsRouter,
  systemRouter,
  authRouter,
  fileRouter,
  projectRouter,
  sessionRouter,
  chatRouter,
  imageGenerationRouter,
  activityRouter,
  deploymentRouter,
);

export default router;
