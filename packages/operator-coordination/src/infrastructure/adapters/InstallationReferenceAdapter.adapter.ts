/**
 * InstallationReferenceAdapter implements InstallationReferencePort over the
 * loaded installation's host and verification procedure names. It returns
 * frozen sorted copies so callers cannot mutate the installation roster, and
 * null when no installation is loaded.
 */

import type {
  InstallationReferencePort,
  InstallationReferences,
} from '../../application/ports/out/InstallationReferencePort.out-port.js';

function compareCodeUnits(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

export class InstallationReferenceAdapter implements InstallationReferencePort {
  constructor(private readonly refs: InstallationReferences | null = null) {}

  references(): InstallationReferences | null {
    if (this.refs === null) {
      return null;
    }
    return Object.freeze({
      hostNames: Object.freeze([...this.refs.hostNames].sort(compareCodeUnits)),
      procedureNames: Object.freeze([...this.refs.procedureNames].sort(compareCodeUnits)),
    });
  }
}
