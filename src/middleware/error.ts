import { Request, Response, NextFunction } from 'express';
import { validationResult } from 'express-validator';
import { ApiError, fail } from '../utils/response';

export const handleValidation = (req: Request, res: Response, next: NextFunction): Response | void => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return fail(res, 422, errors.array()[0].msg || '参数校验失败');
  }
  next();
};

export const errorHandler = (
  err: ApiError | Error,
  req: Request,
  res: Response,
  _next: NextFunction
): Response => {
  console.error('[Error]', err.message, err.stack);

  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      code: err.code,
      message: err.message,
    });
  }

  return res.status(500).json({
    code: 500,
    message: process.env.NODE_ENV === 'production' ? '服务器内部错误' : err.message,
  });
};

export const notFoundHandler = (req: Request, res: Response): Response => {
  return res.status(404).json({
    code: 404,
    message: `路由 ${req.method} ${req.path} 不存在`,
  });
};

export const parsePagination = (req: Request): { page: number; pageSize: number; skip: number } => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
  const skip = (page - 1) * pageSize;
  return { page, pageSize, skip };
};
