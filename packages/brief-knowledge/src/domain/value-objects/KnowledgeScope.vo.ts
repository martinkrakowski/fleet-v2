// @generated value-object stub — refined for migration step 2.
/**
 * KnowledgeScope is an immutable value object bounding where a knowledge
 * entry may be applied. Cross-project reuse requires reviewed shared scope;
 * retrieval filters by authorized scope before ranking.
 */

export interface KnowledgeScopeProps {
  readonly projectId: string;
  readonly pathPrefixes: readonly string[];
  readonly sharedAcrossProjects: boolean;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export class KnowledgeScope {
  private constructor(private readonly props: KnowledgeScopeProps) {
    // Value is immutable after construction.
  }

  static create(props: KnowledgeScopeProps): {
    success: boolean;
    value?: KnowledgeScope;
    error?: Error;
  } {
    if (!isNonEmptyString(props.projectId)) {
      return { success: false, error: new Error('KnowledgeScope requires a non-empty projectId') };
    }
    if (!isStringList(props.pathPrefixes)) {
      return { success: false, error: new Error('KnowledgeScope requires string pathPrefixes') };
    }
    if (typeof props.sharedAcrossProjects !== 'boolean') {
      return { success: false, error: new Error('KnowledgeScope requires a boolean sharedAcrossProjects') };
    }
    return {
      success: true,
      value: new KnowledgeScope({ ...props, pathPrefixes: [...props.pathPrefixes] }),
    };
  }

  getProjectId(): string {
    return this.props.projectId;
  }

  getPathPrefixes(): readonly string[] {
    return [...this.props.pathPrefixes];
  }

  isSharedAcrossProjects(): boolean {
    return this.props.sharedAcrossProjects;
  }

  getProps(): KnowledgeScopeProps {
    return { ...this.props, pathPrefixes: [...this.props.pathPrefixes] };
  }

  /** An entry applies to a project when it owns the entry or shares it. */
  appliesToProject(projectId: string): boolean {
    return this.props.sharedAcrossProjects || this.props.projectId === projectId;
  }

  equals(other: KnowledgeScope): boolean {
    return (
      this.props.projectId === other.props.projectId &&
      this.props.sharedAcrossProjects === other.props.sharedAcrossProjects &&
      shallowEqualLists(this.props.pathPrefixes, other.props.pathPrefixes)
    );
  }
}

function shallowEqualLists(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}
