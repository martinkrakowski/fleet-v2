import { getOperatorComposition } from "../../../wiring/operator/composition.js";
import { projectWriteHandler } from "../../../wiring/operator/project-write.js";

export default projectWriteHandler((request) =>
  getOperatorComposition().updateProjectProfile.execute(request),
);
