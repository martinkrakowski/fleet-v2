/**
 * CloudProviderPort: outbound port for provisioning, draining and terminating
 * one execution host at a cloud provider. The port is defined before any
 * adapter exists (FC8E1): the shared in-memory fake under `__tests__` is the
 * only implementation, and the shared contract suite pins its semantics so a
 * later real adapter cannot drift from the fake.
 *
 * Every request is untrusted input: an adapter must read it through own
 * property descriptors (never a getter), wrap `Object.getPrototypeOf`,
 * `Reflect.ownKeys` and `Object.getOwnPropertyDescriptor` in `try/catch` so a
 * revoked or throwing `Proxy` answers `{ ok: false, reason: 'invalid-request' }`,
 * and refuse `null`, `undefined`, arrays, array-likes, wrong primitives,
 * prototype-polluting keys (`__proto__`, `constructor`, `prototype`), extra,
 * missing, non-enumerable and symbol keys. Every failure is a typed result,
 * never a throw and never a guessed state.
 */

/** A host class the provider may allocate. */
export type HostClass = 'standard' | 'large';

/** A fixed failure reason, never a throw. */
export type CloudProviderFailureReason =
  | 'quota'
  | 'unavailable'
  | 'unknown-host'
  | 'not-drained'
  | 'invalid-request';

/** Provision one host of the requested class. */
export interface ProvisionHostRequest {
  /** Idempotency key: the same requestId with the same hostClass replays the same host. */
  readonly requestId: string;
  readonly hostClass: HostClass;
}

/** Drain one provisioned host (move it out of the live serving pool). */
export interface DrainHostRequest {
  readonly hostId: string;
}

/** Terminate one drained host (release it at the provider). */
export interface TerminateHostRequest {
  readonly hostId: string;
}

export type ProvisionHostResult =
  | { readonly ok: true; readonly hostId: string; readonly hostClass: HostClass }
  | { readonly ok: false; readonly reason: CloudProviderFailureReason };

export type DrainHostResult =
  | { readonly ok: true; readonly hostId: string }
  | { readonly ok: false; readonly reason: CloudProviderFailureReason };

export type TerminateHostResult =
  | { readonly ok: true; readonly hostId: string }
  | { readonly ok: false; readonly reason: CloudProviderFailureReason };

export interface CloudProviderPort {
  provision(request: ProvisionHostRequest): Promise<ProvisionHostResult>;
  drain(request: DrainHostRequest): Promise<DrainHostResult>;
  terminate(request: TerminateHostRequest): Promise<TerminateHostResult>;
}
