// @generated adapter stub — placeholders refuse; no external operation is implemented.
/**
 * ExecutionRunnerAdapter implements ExecutionRunnerPort
 *
 * Intended integration (manifest adapter_bindings): reviewed `ocm-run`
 * subprocess on the attempt's port. Not implemented in migration step 1.
 */

import type {
  ExecutionRunnerPort,
  RunnerIsolationCapabilities,
  RunnerSessionRef,
  RunnerSessionStatus,
  StartRunnerSessionRequest,
  StartRunnerSessionResult,
  StopRunnerSessionRequest,
  StopRunnerSessionResult,
} from '../../application/ports/out/ExecutionRunnerPort.out-port.js';

export class ExecutionRunnerAdapter implements ExecutionRunnerPort {
  describeCapabilities(): RunnerIsolationCapabilities {
    throw new Error('Not implemented: ExecutionRunnerAdapter.describeCapabilities');
  }

  startSession(_request: StartRunnerSessionRequest): Promise<StartRunnerSessionResult> {
    return Promise.reject(new Error('Not implemented: ExecutionRunnerAdapter.startSession'));
  }

  inspectSession(_session: RunnerSessionRef): Promise<RunnerSessionStatus> {
    return Promise.reject(new Error('Not implemented: ExecutionRunnerAdapter.inspectSession'));
  }

  stopSession(_request: StopRunnerSessionRequest): Promise<StopRunnerSessionResult> {
    return Promise.reject(new Error('Not implemented: ExecutionRunnerAdapter.stopSession'));
  }
}
