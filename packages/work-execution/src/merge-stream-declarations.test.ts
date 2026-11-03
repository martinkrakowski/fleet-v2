import { describe, expect, it } from 'vitest';
import * as workExecution from './index.js';

describe('merge-stream declarations', () => {
  it('exports ImportTrainStateUseCase', () => {
    expect(typeof workExecution.ImportTrainStateUseCase).toBe('function');
  });

  it('exports ExportLegacyTrainStateUseCase', () => {
    expect(typeof workExecution.ExportLegacyTrainStateUseCase).toBe('function');
  });

  it('exports InspectMergeReadinessUseCase', () => {
    expect(typeof workExecution.InspectMergeReadinessUseCase).toBe('function');
  });

  it('exports ManageDaemonSchedulerUseCase', () => {
    expect(typeof workExecution.ManageDaemonSchedulerUseCase).toBe('function');
  });

  it('exports LegacyTrainStateReadAdapter', () => {
    expect(typeof workExecution.LegacyTrainStateReadAdapter).toBe('function');
  });

  it('exports SystemdUserSchedulerAdapter', () => {
    expect(typeof workExecution.SystemdUserSchedulerAdapter).toBe('function');
  });
});
