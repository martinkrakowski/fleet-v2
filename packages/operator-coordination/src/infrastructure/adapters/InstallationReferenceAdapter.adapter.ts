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

export class InstallationReferenceAdapter implements InstallationReferencePort {
  constructor(private readonly refs: InstallationReferences | null = null) {}

  references(): InstallationReferences | null {
    if (this.refs === null) {
      return null;
    }
    return Object.freeze({
      hostNames: Object.freeze([...this.refs.hostNames].sort()),
      procedureNames: Object.freeze([...this.refs.procedureNames].sort()),
    });
  }
}
