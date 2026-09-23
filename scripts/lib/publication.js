"use strict";
function assertGeneratedPaths(files) {
  if (!files.length || files.some(file =>
    !/^(README\.md|dist\/verified\.json|(?:badges|state)\/[a-z0-9][a-z0-9-]*\.json)$/.test(file))) {
    throw new Error("publication must contain only generated README, feed, badges and probe state");
  }
}
function initialProbeNeeded(state) { return !(state.probes || []).length; }
module.exports = { assertGeneratedPaths, initialProbeNeeded };
