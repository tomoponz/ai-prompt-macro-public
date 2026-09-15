export function countWorkflowStepTypes(steps = []) {
  let waits = 0;
  let delaySteps = 0;
  let waitUntilSteps = 0;
  let checkpoints = 0;

  for (const step of steps) {
    if (step?.type === "delay") {
      waits += 1;
      delaySteps += 1;
      continue;
    }
    if (step?.type === "wait-until") {
      waits += 1;
      waitUntilSteps += 1;
      continue;
    }
    if (step?.type === "checkpoint") checkpoints += 1;
  }

  return { waits, delaySteps, waitUntilSteps, checkpoints };
}
