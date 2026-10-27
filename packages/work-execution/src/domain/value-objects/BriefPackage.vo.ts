// @generated value-object stub — refined for migration step 1.
/**
 * BriefPackage is an immutable value object for one frozen brief package:
 * identity-bound paths, digests and revision references. The digest is
 * integrity, not truth; the package owns at least one path. The package
 * carries the acceptance spec its gate runs.
 */

import { AcceptanceSpec } from './AcceptanceSpec.vo.js';

export interface BriefPackageProps {
  readonly attemptId: string;
  readonly briefDigest: string;
  readonly prosePath: string;
  readonly manifestPath: string;
  readonly baseCommit: string;
  readonly policyRevision: string;
  readonly independentReviewer: string;
  readonly ownedPaths: readonly string[];
  readonly acceptanceSpec: AcceptanceSpec;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const STRING_FIELDS: readonly (keyof BriefPackageProps)[] = [
  'attemptId',
  'briefDigest',
  'prosePath',
  'manifestPath',
  'baseCommit',
  'policyRevision',
  'independentReviewer',
];

export class BriefPackage {
  private constructor(private readonly props: BriefPackageProps) {
    // Value is immutable after construction.
  }

  static create(props: BriefPackageProps): { success: boolean; value?: BriefPackage; error?: Error } {
    for (const field of STRING_FIELDS) {
      if (!isNonEmptyString(props[field])) {
        return { success: false, error: new Error(`BriefPackage requires a non-empty ${String(field)}`) };
      }
    }
    if (!Array.isArray(props.ownedPaths) || props.ownedPaths.length === 0) {
      return { success: false, error: new Error('BriefPackage requires at least one owned path') };
    }
    if (props.ownedPaths.some((path) => !isNonEmptyString(path))) {
      return { success: false, error: new Error('BriefPackage owned paths must be non-empty strings') };
    }
    if (!(props.acceptanceSpec instanceof AcceptanceSpec)) {
      return { success: false, error: new Error('BriefPackage requires an acceptance spec') };
    }
    return { success: true, value: new BriefPackage({ ...props, ownedPaths: [...props.ownedPaths] }) };
  }

  getAttemptId(): string {
    return this.props.attemptId;
  }

  getBriefDigest(): string {
    return this.props.briefDigest;
  }

  getProsePath(): string {
    return this.props.prosePath;
  }

  getManifestPath(): string {
    return this.props.manifestPath;
  }

  getBaseCommit(): string {
    return this.props.baseCommit;
  }

  getPolicyRevision(): string {
    return this.props.policyRevision;
  }

  getIndependentReviewer(): string {
    return this.props.independentReviewer;
  }

  getOwnedPaths(): readonly string[] {
    return this.props.ownedPaths;
  }

  getAcceptanceSpec(): AcceptanceSpec {
    return this.props.acceptanceSpec;
  }

  getProps(): BriefPackageProps {
    return this.props;
  }

  equals(other: BriefPackage): boolean {
    return (
      this.props.attemptId === other.props.attemptId &&
      this.props.briefDigest === other.props.briefDigest &&
      this.props.prosePath === other.props.prosePath &&
      this.props.manifestPath === other.props.manifestPath &&
      this.props.baseCommit === other.props.baseCommit &&
      this.props.policyRevision === other.props.policyRevision &&
      this.props.independentReviewer === other.props.independentReviewer &&
      this.props.ownedPaths.length === other.props.ownedPaths.length &&
      this.props.ownedPaths.every((path, index) => path === other.props.ownedPaths[index]) &&
      this.props.acceptanceSpec.equals(other.props.acceptanceSpec)
    );
  }
}
