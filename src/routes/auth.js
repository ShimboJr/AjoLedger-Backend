import { Router } from 'express';
import {
  register,
  login,
  me,
  validate,
  requireAuth,
  authLimiter,
  registerSchema,
  loginSchema,
} from '../controllers/authController.js';

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), register);
router.post('/login',    authLimiter, validate(loginSchema),    login);
router.get('/me',        requireAuth,                           me);

export default router;
