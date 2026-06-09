import { Response } from 'express';

export interface ApiResponse<T = any> {
  code: number;
  message: string;
  data?: T;
  total?: number;
  page?: number;
  pageSize?: number;
}

export class ApiError extends Error {
  statusCode: number;
  code: number;

  constructor(statusCode: number, code: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

export const success = <T>(res: Response, data?: T, message: string = 'success'): Response => {
  return res.json({
    code: 0,
    message,
    data,
  });
};

export const successWithPagination = <T>(
  res: Response,
  data: T,
  total: number,
  page: number,
  pageSize: number,
  message: string = 'success'
): Response => {
  return res.json({
    code: 0,
    message,
    data,
    total,
    page,
    pageSize,
  });
};

export const fail = (res: Response, code: number = 400, message: string = 'error'): Response => {
  return res.status(400).json({
    code,
    message,
  });
};
