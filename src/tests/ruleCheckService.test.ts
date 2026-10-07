import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuleAnalysis } from '../models/ruleModel';
import { createDemoWorkspace } from '../models/projectFactory';
import {
  CHECK_TIMEOUT_MS,
  RuleCheckService,
  RuleCheckTimeoutError,
  type CheckWorkerLike,
} from '../services/ruleCheckService';

class FakeWorker implements CheckWorkerLike {
  static instances: FakeWorker[] = [];
  onmessage: CheckWorkerLike['onmessage'] = null;
  onerror: CheckWorkerLike['onerror'] = null;
  posted: { requestId: number }[] = [];
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.posted.push(message as { requestId: number });
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(analysis: RuleAnalysis): void {
    this.onmessage?.({ data: { requestId: this.posted[0].requestId, analysis } } as MessageEvent);
  }

  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

const project = createDemoWorkspace().projects[0];

const stubAnalysis: RuleAnalysis = {
  checkedCases: 10,
  coveredCases: 8,
  coveragePercent: 80,
  overlaps: [],
  unreachableRuleIds: [],
  shadowedRuleIds: [],
  uncoveredExamples: [],
  truncated: false,
};

describe('RuleCheckService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.instances = [];
  });

  it('resolves with the analysis and cleans up the worker and timer', async () => {
    const service = new RuleCheckService(() => new FakeWorker());
    const operation = service.run(project);
    const worker = FakeWorker.instances[0];
    worker.respond(stubAnalysis);
    await expect(operation.promise).resolves.toBe(stubAnalysis);
    expect(worker.terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a stuck check, terminates the worker, and reports a timeout failure', async () => {
    const service = new RuleCheckService(() => new FakeWorker());
    const operation = service.run(project);
    const assertion = expect(operation.promise).rejects.toBeInstanceOf(RuleCheckTimeoutError);
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    await assertion;
    await expect(operation.promise).rejects.toThrow('超时');
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('supports a custom timeout budget for heavy computations', async () => {
    const service = new RuleCheckService(() => new FakeWorker());
    const operation = service.run(project, 500);
    const assertion = expect(operation.promise).rejects.toBeInstanceOf(RuleCheckTimeoutError);
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeWorker.instances[0].terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it('cancels cleanly and never fires the timeout afterwards', async () => {
    const service = new RuleCheckService(() => new FakeWorker());
    const operation = service.run(project);
    const assertion = expect(operation.promise).rejects.toMatchObject({ name: 'AbortError' });
    operation.cancel();
    await assertion;
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS * 2);
  });

  it('rejects with the worker error message when the environment fails', async () => {
    const service = new RuleCheckService(() => new FakeWorker());
    const operation = service.run(project);
    const assertion = expect(operation.promise).rejects.toThrow('worker crashed');
    FakeWorker.instances[0].fail('worker crashed');
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});
