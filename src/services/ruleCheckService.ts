import type { RuleAnalysis, RuleProject } from '../models/ruleModel';
import RuleCheckWorker from './ruleCheck.worker?worker';

export interface CheckOperation {
  promise: Promise<RuleAnalysis>;
  cancel: () => void;
}

export const CHECK_TIMEOUT_MS = 15_000;

export class RuleCheckTimeoutError extends Error {
  constructor(message = '计算超时：超过预期时间仍未完成，已自动结束。可减少字段或取值组合后重新检查。') {
    super(message);
    this.name = 'RuleCheckTimeoutError';
  }
}

interface CheckWorkerMessage {
  requestId: number;
  analysis?: RuleAnalysis;
  error?: string;
}

export interface CheckWorkerLike {
  onmessage: ((event: MessageEvent<CheckWorkerMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

export class RuleCheckService {
  private nextRequestId = 1;

  constructor(private readonly createWorker: () => CheckWorkerLike = () => new RuleCheckWorker()) {}

  run(project: RuleProject, timeoutMs: number = CHECK_TIMEOUT_MS): CheckOperation {
    const worker = this.createWorker();
    const requestId = this.nextRequestId++;
    let rejectPending: (reason: Error) => void = () => undefined;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settle = (): void => {
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = undefined;
      worker.terminate();
    };
    const promise = new Promise<RuleAnalysis>((resolve, reject) => {
      rejectPending = reject;
      worker.onmessage = (event) => {
        if (event.data.requestId !== requestId || settled) return;
        settle();
        if (event.data.analysis) resolve(event.data.analysis);
        else reject(new Error(event.data.error ?? '规则分析失败'));
      };
      worker.onerror = (event) => {
        if (settled) return;
        settle();
        reject(new Error(event.message || '规则检查 Worker 运行失败'));
      };
      timeout = setTimeout(() => {
        if (settled) return;
        settle();
        reject(new RuleCheckTimeoutError());
      }, timeoutMs);
      worker.postMessage({ requestId, project });
    });
    return {
      promise,
      cancel: () => {
        if (settled) return;
        settle();
        rejectPending(new DOMException('规则检查已取消', 'AbortError'));
      },
    };
  }
}
