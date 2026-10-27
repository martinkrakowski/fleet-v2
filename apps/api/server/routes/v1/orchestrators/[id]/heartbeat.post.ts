// POST /v1/orchestrators/[id]/heartbeat: the presenting token's own session only.
import { ownedSessionRoute } from "../../../../wiring/owned-session-route.js";

export default ownedSessionRoute((composition, orchestratorId, presentedTokenId) =>
  composition.heartbeatOrchestratorSession.heartbeatOrchestratorSession({ orchestratorId }, presentedTokenId),
);
