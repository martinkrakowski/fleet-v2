// @generated outbound contract scaffold — refined for P3a.
/**
 * InstallationReferencePort: report the installation's host names and
 * verification procedure names so profile writes can refuse names the
 * installation does not have; null when no installation is loaded.
 */
export interface InstallationReferences {
  readonly hostNames: readonly string[];
  readonly procedureNames: readonly string[];
}

export interface InstallationReferencePort {
  references(): InstallationReferences | null;
}
