import type { RuleAnalysis, RuleProject } from '../models/ruleModel';
import RuleCheckWorker from './ruleCheck.worker?worker';

export interface CheckRequest {
  requestId: number;
  project: RuleProject;
}

export interface CheckResponse {
  requestId: number;
  analysis?: RuleAnalysis;
  error?: string;
}

export interface CheckOperation {
  promise: Promise<RuleAnalysis>;
  cancel: () => void;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 30_000;

export class CheckTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`检查超时：计算超过 ${Math.round(timeoutMs / 1000)} 秒仍未返回结果，已自动终止本次检查。可减少字段组合后重试，或稍后再试。`);
    this.name = 'CheckTimeoutError';
  }
}

interface RuleCheckServiceOptions {
  timeoutMs?: number;
  workerFactory?: () => Worker;
}

export class RuleCheckService {
  private nextRequestId = 1;
  private readonly timeoutMs: number;
  private readonly workerFactory: () => Worker;

  constructor(options: RuleCheckServiceOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    this.workerFactory = options.workerFactory ?? (() => new RuleCheckWorker());
  }

  run(project: RuleProject): CheckOperation {
    const worker = this.workerFactory();
    const requestId = this.nextRequestId++;
    let rejectPending: (reason: Error) => void = () => undefined;
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    // 所有结束路径（结果、错误、超时、取消）都经过这里：
    // 只结算一次，并清理定时器与 Worker，避免残留中间状态。
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      worker.terminate();
      settle();
    };

    const promise = new Promise<RuleAnalysis>((resolve, reject) => {
      rejectPending = reject;
      worker.onmessage = (event: MessageEvent<CheckResponse>) => {
        if (event.data.requestId !== requestId) return;
        finish(() => {
          if (event.data.analysis) resolve(event.data.analysis);
          else reject(new Error(event.data.error ?? '规则分析失败'));
        });
      };
      worker.onerror = (event) => {
        finish(() => reject(new Error(event.message || '规则检查 Worker 运行失败')));
      };
      if (this.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          finish(() => reject(new CheckTimeoutError(this.timeoutMs)));
        }, this.timeoutMs);
      }
      const request: CheckRequest = { requestId, project };
      worker.postMessage(request);
    });
    return {
      promise,
      cancel: () => finish(() => rejectPending(new DOMException('规则检查已取消', 'AbortError'))),
    };
  }
}
