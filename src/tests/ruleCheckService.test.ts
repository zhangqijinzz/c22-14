import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuleAnalysis } from '../models/ruleModel';
import { createDemoWorkspace } from '../models/projectFactory';
import { CheckTimeoutError, RuleCheckService } from '../services/ruleCheckService';

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  posted: unknown[] = [];

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

const demoProject = () => createDemoWorkspace().projects[0];
const asWorker = (worker: FakeWorker) => worker as unknown as Worker;

describe('RuleCheckService', () => {
  beforeEach(() => vi.useFakeTimers());

  it('rejects with a timeout error and terminates the worker when no result arrives', async () => {
    const worker = new FakeWorker();
    const service = new RuleCheckService({ timeoutMs: 1000, workerFactory: () => asWorker(worker) });
    const operation = service.run(demoProject());
    const assertion = expect(operation.promise).rejects.toBeInstanceOf(CheckTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    await expect(operation.promise).rejects.toThrow(/超时/);
    expect(worker.terminated).toBe(true);
  });

  it('ignores a late result that arrives after the timeout', async () => {
    const worker = new FakeWorker();
    const service = new RuleCheckService({ timeoutMs: 1000, workerFactory: () => asWorker(worker) });
    const operation = service.run(demoProject());
    const outcomes: string[] = [];
    void operation.promise.then(
      () => outcomes.push('resolved'),
      (error: Error) => outcomes.push(`rejected:${error.name}`),
    );
    await vi.advanceTimersByTimeAsync(1000);
    worker.respond({ requestId: 1, analysis: { checkedCases: 1 } as RuleAnalysis });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(outcomes).toEqual(['rejected:CheckTimeoutError']);
  });

  it('resolves with the analysis and cleans up when the result arrives in time', async () => {
    const worker = new FakeWorker();
    const service = new RuleCheckService({ timeoutMs: 1000, workerFactory: () => asWorker(worker) });
    const analysis = { checkedCases: 3 } as RuleAnalysis;
    const operation = service.run(demoProject());
    const request = worker.posted[0] as { requestId: number };
    worker.respond({ requestId: request.requestId, analysis });
    await expect(operation.promise).resolves.toBe(analysis);
    expect(worker.terminated).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(worker.terminated).toBe(true);
  });

  it('cancel rejects with AbortError and terminates the worker exactly once', async () => {
    const worker = new FakeWorker();
    const service = new RuleCheckService({ timeoutMs: 1000, workerFactory: () => asWorker(worker) });
    const operation = service.run(demoProject());
    operation.cancel();
    operation.cancel();
    await expect(operation.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminated).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(worker.terminated).toBe(true);
  });
});
