import { ApiError } from '../api'
import { errorMessage } from './format'

export function authErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 401: return '用户名或密码错误'
      case 403: return '该账号不能用于此入口'
      case 409: return '用户名已存在，请换一个'
      case 429: return '尝试过于频繁，请稍后再试'
      case 400: return '输入不符合要求，请检查用户名与密码格式'
      default: return error.message
    }
  }
  return errorMessage(error)
}
