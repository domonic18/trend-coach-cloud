export class JobCanceledError extends Error {
  constructor() {
    super('job canceled')
    this.name = 'JobCanceledError'
  }
}

/** 管线内部失败统一用稳定错误码与可重试标记，响应与日志只暴露错误码。 */
export class PipelineFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code)
    this.name = 'PipelineFailure'
  }
}
